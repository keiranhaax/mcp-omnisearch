import { McpServer } from 'tmcp';
import * as v from 'valibot';
import {
	input_error,
	public_error_metadata,
	type PublicErrorMetadata,
} from '../../common/errors.js';
import { fuse_results, RRF_K } from '../../common/rank_fusion.js';
import {
	combine_request_signal,
	run_with_request_context,
} from '../../common/request_context.js';
import {
	get_response_metadata,
	usage_source,
} from '../../common/response_metadata.js';
import { handle_large_result } from '../../common/results.js';
import {
	create_output_schema,
	error_metadata_schema,
	retained_schema,
	tool_error,
	tool_success,
} from '../../common/tool_output.js';
import type { SearchResult } from '../../common/types.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { assert_provider_not_cooling } from '../provider_cooldown.js';
import { assert_spend_within_cap } from '../spend_caps.js';
import {
	get_available_providers as search_providers,
	get_search_provider,
} from './web_search.js';

/**
 * Explicit multi-provider search: the caller names two or three web
 * search providers, each is queried in parallel through the ordinary
 * provider path (spending caps, cooldowns, health, metrics and the
 * request budget all apply per provider), and the lists are merged
 * with reciprocal rank fusion after URL canonicalisation. Providers
 * that fail are reported beside the results instead of failing the
 * call, unless every provider failed.
 */

const MAX_PROVIDERS = 3;
// Providers cap their own page size at 20; asking for more only costs.
const MAX_PER_PROVIDER = 20;

const usage_schema = v.nullable(
	v.union([
		v.object({ credits: v.number() }),
		v.object({ usd: v.number() }),
	]),
);
const provider_outcome_schema = v.object({
	name: v.string(),
	status: v.picklist(['ok', 'error']),
	results: v.number(),
	elapsed_ms: v.nullable(v.number()),
	usage: usage_schema,
	usage_source: v.picklist(['provider_reported', 'cache', 'unknown']),
	error: v.optional(error_metadata_schema),
});
const fused_result_schema = v.looseObject({
	title: v.string(),
	url: v.string(),
	snippet: v.string(),
	score: v.number(),
	source_provider: v.string(),
	source_providers: v.array(v.string()),
	ranks: v.record(v.string(), v.number()),
	canonical_url: v.string(),
	metadata: v.optional(v.record(v.string(), v.unknown())),
});
export const fused_data_schema = v.object({
	query: v.string(),
	results: v.array(fused_result_schema),
	providers: v.array(provider_outcome_schema),
	metadata: v.looseObject({
		fusion: v.literal('rrf'),
		k: v.number(),
		limit: v.number(),
		requested: v.number(),
		answered: v.number(),
		candidates: v.number(),
		duplicates_removed: v.number(),
		complete: v.boolean(),
		elapsed_ms: v.number(),
	}),
});
export const fused_output_schema: v.GenericSchema<{
	ok: boolean;
	data?: unknown;
	error?: PublicErrorMetadata;
}> = create_output_schema(
	v.union([fused_data_schema, retained_schema]),
);

const integer = (
	min: number,
	max: number,
	value: number,
	description: string,
) =>
	v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(min),
			v.maxValue(max),
			v.description(description),
		),
		value,
	);
const domains = (description: string) =>
	v.optional(
		v.pipe(
			v.array(v.pipe(v.string(), v.maxLength(253))),
			v.maxLength(50),
			v.description(description),
		),
	);

type ProviderOutcome = v.InferOutput<typeof provider_outcome_schema>;

export const register_web_search_fused = (
	server: McpServer<v.GenericSchema>,
) => {
	const names = search_providers();
	if (names.length < 2) return;
	server.tool(
		{
			name: 'web_search_fused',
			outputSchema: fused_output_schema,
			description:
				"Search 2-3 explicit web providers in parallel and merge their results with reciprocal rank fusion (k=60) after URL canonicalisation. Reports each provider's outcome and cost; partial results when some fail. No synthesis or fallback.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.strictObject({
				query: v.pipe(v.string(), v.minLength(1), v.maxLength(5000)),
				providers: v.pipe(
					v.array(v.picklist(names)),
					v.minLength(2),
					v.maxLength(MAX_PROVIDERS),
					v.description(
						'Two or three distinct web search providers, queried in parallel. Order decides which provider supplies the title and snippet of a merged result.',
					),
				),
				limit: integer(
					1,
					50,
					10,
					'Maximum fused results; each provider is asked for the same number, capped at 20. Default 10.',
				),
				include_domains: domains(
					'Only return results from these domains; passed to every provider.',
				),
				exclude_domains: domains(
					'Exclude results from these domains; passed to every provider.',
				),
				timeout_ms: integer(
					100,
					60000,
					30000,
					'Whole call deadline in milliseconds; default 30000.',
				),
			}),
		},
		async ({
			query,
			providers,
			limit = 10,
			include_domains,
			exclude_domains,
			timeout_ms = 30000,
		}) => {
			const started = performance.now();
			const deadline = new AbortController();
			const timer = setTimeout(
				() =>
					deadline.abort(
						new DOMException('Operation timed out', 'TimeoutError'),
					),
				timeout_ms,
			);
			timer.unref();
			const signal = combine_request_signal(deadline.signal);
			try {
				if (!query.trim())
					throw input_error(
						'Search query is required',
						'web_search_fused',
					);
				if (new Set(providers).size !== providers.length)
					throw input_error(
						'providers must be distinct',
						'web_search_fused',
					);
				const selected = providers.map((name) => {
					const provider = get_search_provider(name);
					if (!provider)
						throw input_error(
							'Provider is not available',
							'web_search_fused',
						);
					return { name, provider };
				});
				const data = await run_with_request_context(
					signal,
					async () => {
						const lists: Array<{
							provider: string;
							results: SearchResult[];
						}> = [];
						const outcomes: ProviderOutcome[] = [];
						const failures: unknown[] = [];
						await Promise.all(
							selected.map(async ({ name, provider }, index) => {
								const began = performance.now();
								const outcome: ProviderOutcome = {
									name,
									status: 'error',
									results: 0,
									elapsed_ms: null,
									usage: null,
									usage_source: 'unknown',
								};
								outcomes[index] = outcome;
								try {
									assert_spend_within_cap(name);
									assert_provider_not_cooling('search', name);
									const results = await provider.search({
										query,
										limit: Math.min(limit, MAX_PER_PROVIDER),
										include_domains,
										exclude_domains,
									});
									const elapsed_ms = Math.round(
										performance.now() - began,
									);
									const reported = get_response_metadata(results);
									mark_provider_success('search', name, {
										tool: 'web_search_fused',
										elapsed_ms,
										usage: reported?.usage,
										cached: reported?.cached === true,
									});
									lists[index] = { provider: name, results };
									Object.assign(outcome, {
										status: 'ok',
										results: results.length,
										elapsed_ms,
										usage: reported?.usage ?? null,
										usage_source: usage_source(reported),
									});
								} catch (error) {
									outcome.elapsed_ms = Math.round(
										performance.now() - began,
									);
									outcome.error = public_error_metadata(error);
									failures[index] = error;
									if (
										!signal?.aborted &&
										outcome.error.kind !== 'request_budget'
									)
										mark_provider_error('search', name, error, {
											tool: 'web_search_fused',
											elapsed_ms: outcome.elapsed_ms,
										});
								}
							}),
						);
						const answered = lists.filter(Boolean);
						if (!answered.length)
							throw failures.find((failure) => failure !== undefined);
						const fused = fuse_results(answered, { limit });
						return {
							query,
							results: fused.results,
							providers: outcomes,
							metadata: {
								fusion: 'rrf' as const,
								k: RRF_K,
								limit,
								requested: selected.length,
								answered: answered.length,
								candidates: fused.candidates,
								duplicates_removed: fused.duplicates_removed,
								unaddressed: fused.unaddressed,
								complete: answered.length === selected.length,
								elapsed_ms: Math.round(performance.now() - started),
							},
						};
					},
					{ http_budget: { limit: selected.length * 2, used: 0 } },
				);
				return tool_success(
					handle_large_result(data, 'web_search_fused'),
				);
			} catch (error) {
				return tool_error(error);
			} finally {
				clearTimeout(timer);
			}
		},
	);
};
