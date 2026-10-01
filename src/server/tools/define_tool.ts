import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import {
	present_result,
	validate_presentation,
} from '../../common/presentation.js';
import { get_response_metadata } from '../../common/response_metadata.js';
import { handle_large_result } from '../../common/results.js';
import {
	output_schema,
	tool_success,
	tool_success_bytes,
	tool_error,
} from '../../common/tool_output.js';
import {
	mark_provider_error,
	mark_provider_success,
	type ProviderCategory,
} from '../provider_health.js';
import { assert_spend_within_cap } from '../spend_caps.js';

/**
 * Shared registration for provider-backed tools. The public contract
 * (name, description, annotations, input schema) passes through
 * unchanged; the helper owns only the lifecycle every handler repeated:
 * timing, presentation validation, result rendering, provider health
 * marking and the success/error envelopes.
 */

export interface ToolAnnotations {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

export interface ToolContract<TSchema extends GenericSchema> {
	name: string;
	description: string;
	annotations: ToolAnnotations;
	schema: TSchema;
	/** Health category the provider is registered under. */
	category: ProviderCategory;
	/** Health key: a fixed provider, or one derived from validated input. */
	provider: string | ((input: v.InferOutput<TSchema>) => string);
}

export interface PresentedOutcome {
	/** Raw provider result, presented by `present_result`. */
	result: unknown;
	operation: string;
	query?: string;
	urls?: string | string[];
}

interface PresentationInput {
	response_mode?: 'legacy' | 'compact' | 'full';
	output_budget_bytes?: number;
}

// Provider-reported usage travels on the result object; read it before
// presentation replaces that object with a rendered view. A cached
// replay carries no usage: that call was charged when the cache filled.
const reported_outcome = (result: unknown) => {
	const metadata =
		result && typeof result === 'object'
			? get_response_metadata(result)
			: undefined;
	return {
		usage: metadata?.cached ? null : (metadata?.usage ?? null),
		cached: metadata?.cached === true,
		...(metadata?.job ? { job_id: metadata.job.id } : {}),
	};
};

const resolve_provider = <TSchema extends GenericSchema>(
	contract: ToolContract<TSchema>,
	input: v.InferOutput<TSchema>,
) =>
	typeof contract.provider === 'function'
		? contract.provider(input)
		: contract.provider;

/**
 * A tool whose input carries presentation controls and whose output is
 * the structured `{ ok, data | error }` envelope.
 */
export const define_presented_tool = <TSchema extends GenericSchema>(
	server: McpServer<GenericSchema>,
	contract: ToolContract<TSchema>,
	run: (
		input: v.InferOutput<TSchema>,
		context: { started: number },
	) => Promise<PresentedOutcome>,
) => {
	server.tool(
		{
			name: contract.name,
			description: contract.description,
			outputSchema: output_schema,
			annotations: contract.annotations,
			schema: contract.schema as never,
		},
		// The public schema is forwarded untouched; tmcp validates against
		// it at runtime. The generic contract cannot satisfy tmcp's
		// conditional handler type statically, so the pair is cast here and
		// `run` carries the real input type.
		(async (raw_input: unknown) => {
			const input = raw_input as v.InferOutput<TSchema> &
				PresentationInput;
			const provider = resolve_provider(contract, input);
			const started = performance.now();
			try {
				validate_presentation({
					response_mode: input.response_mode,
					output_budget_bytes: input.output_budget_bytes,
				});
				assert_spend_within_cap(provider);
				const outcome = await run(input, { started });
				const elapsed_ms = Math.round(performance.now() - started);
				const presented = present_result(outcome.result, {
					provider,
					operation: outcome.operation,
					query: outcome.query,
					urls: outcome.urls,
					response_mode: input.response_mode,
					output_budget_bytes: input.output_budget_bytes,
					measure_bytes: tool_success_bytes,
					elapsed_ms,
				});
				mark_provider_success(contract.category, provider, {
					tool: contract.name,
					elapsed_ms,
					...reported_outcome(outcome.result),
				});
				return tool_success(presented);
			} catch (error) {
				mark_provider_error(contract.category, provider, error, {
					tool: contract.name,
					elapsed_ms: Math.round(performance.now() - started),
				});
				return tool_error(error);
			}
		}) as never,
	);
};

/**
 * A tool with the original text-only envelope: the JSON result (or an
 * opaque large-result handle) as text, errors as text with `isError`.
 */
export const define_legacy_tool = <TSchema extends GenericSchema>(
	server: McpServer<GenericSchema>,
	contract: ToolContract<TSchema>,
	run: (input: v.InferOutput<TSchema>) => Promise<unknown>,
) => {
	server.tool(
		{
			name: contract.name,
			description: contract.description,
			annotations: contract.annotations,
			schema: contract.schema as never,
		},
		// The public schema is forwarded untouched; tmcp validates against
		// it at runtime. The generic contract cannot satisfy tmcp's
		// conditional handler type statically, so the pair is cast here and
		// `run` carries the real input type.
		(async (raw_input: unknown) => {
			const input = raw_input as v.InferOutput<TSchema>;
			const provider = resolve_provider(contract, input);
			const started = performance.now();
			try {
				assert_spend_within_cap(provider);
				const result = await run(input);
				const safe_result = handle_large_result(
					result,
					contract.name,
				);
				mark_provider_success(contract.category, provider, {
					tool: contract.name,
					elapsed_ms: Math.round(performance.now() - started),
					...reported_outcome(result),
				});
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(safe_result, null, 2),
						},
					],
				};
			} catch (error) {
				mark_provider_error(contract.category, provider, error, {
					tool: contract.name,
					elapsed_ms: Math.round(performance.now() - started),
				});
				return {
					content: [
						{
							type: 'text' as const,
							text: create_error_response(error).error,
						},
					],
					isError: true,
				};
			}
		}) as never,
	);
};
