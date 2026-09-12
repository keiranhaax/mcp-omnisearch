import * as v from 'valibot';
import type { PublicErrorMetadata } from './errors.js';
import {
	create_error_response,
	public_error_metadata,
} from './errors.js';

// MCP requires an object-root output schema. The helpers emit exactly
// one branch: { ok: true, data } or { ok: false, error }.
export const create_output_schema = <T extends v.GenericSchema>(
	data_schema: T,
) =>
	v.object({
		ok: v.boolean(),
		data: v.optional(data_schema),
		error: v.optional(
			v.object({
				kind: v.picklist([
					'authentication',
					'entitlement',
					'rate_limit',
					'timeout',
					'cancelled',
					'endpoint_mismatch',
					'bad_input',
					'storage_failure',
					'request_budget',
					'upstream_failure',
				]),
				retryable: v.boolean(),
				provider: v.optional(v.string()),
				http_status: v.optional(v.number()),
				job_id: v.optional(v.string()),
				request_id: v.optional(v.string()),
			}),
		),
	});

const metadata_schema = v.record(v.string(), v.unknown());
const search_results_schema = v.array(
	v.looseObject({
		title: v.string(),
		url: v.string(),
		snippet: v.string(),
		score: v.optional(v.number()),
		source_provider: v.string(),
		metadata: v.optional(metadata_schema),
	}),
);
const processing_entries = {
	content: v.string(),
	raw_contents: v.optional(
		v.array(
			v.looseObject({
				url: v.string(),
				content: v.string(),
			}),
		),
	),
	metadata: metadata_schema,
	source_provider: v.string(),
};
const processing_schema = v.looseObject(processing_entries);
// Presentation removes content only when raw_contents reconstructs it.
const canonical_processing_schema = v.looseObject({
	...processing_entries,
	content: v.optional(v.string()),
});
const stored_entries = {
	result_id: v.string(),
	total_lines: v.number(),
	expires_at: v.string(),
};
const retained_schema = v.looseObject({
	...stored_entries,
	estimated_tokens: v.number(),
	sections: v.array(
		v.object({ title: v.string(), line: v.number() }),
	),
	sections_truncated: v.boolean(),
	read_hint: v.string(),
	metadata: v.optional(metadata_schema),
});
const presentation_result_schema = v.looseObject({
	response_mode: v.picklist(['compact', 'full']),
	metadata: v.looseObject({
		provider: v.string(),
		operation: v.string(),
		elapsed_ms: v.number(),
		request_id: v.optional(v.string()),
		response_time_seconds: v.optional(v.number()),
		usage: v.nullable(
			v.union([
				v.object({ credits: v.number() }),
				v.object({ usd: v.number() }),
			]),
		),
		usage_source: v.picklist(['provider_reported', 'unknown']),
		local_completeness: v.picklist([
			'complete',
			'retained',
			'selected',
		]),
		provider_partial: v.boolean(),
		provider_page_completeness: v.literal('unknown'),
	}),
	warnings: v.optional(v.array(v.string())),
	result: v.optional(
		v.union([search_results_schema, canonical_processing_schema]),
	),
	...v.partial(v.object(stored_entries)).entries,
	read_hint: v.optional(v.string()),
	offset_unit: v.optional(
		v.literal('utf16_code_units_in_canonical_source'),
	),
	source_count: v.optional(v.number()),
	omitted_sources: v.optional(v.number()),
	sources: v.optional(
		v.array(
			v.object({
				id: v.string(),
				url: v.optional(v.string()),
				title: v.optional(v.string()),
				selection_method: v.string(),
				omitted: v.boolean(),
				passages: v.array(
					v.object({
						start: v.number(),
						end: v.number(),
						text: v.string(),
					}),
				),
			}),
		),
	),
});

export const output_schema: v.GenericSchema<{
	ok: boolean;
	data?: unknown;
	error?: PublicErrorMetadata;
}> = create_output_schema(
	v.union([
		search_results_schema,
		processing_schema,
		retained_schema,
		presentation_result_schema,
	]),
);

export const tool_success = <T>(value: T) => ({
	content: [
		{ type: 'text' as const, text: JSON.stringify(value, null, 2) },
	],
	structuredContent: { ok: true as const, data: value },
});

export const tool_success_bytes = (value: unknown): number =>
	Buffer.byteLength(JSON.stringify(tool_success(value)), 'utf8');

export const tool_error = (error: unknown) => ({
	content: [
		{
			type: 'text' as const,
			text: create_error_response(error).error,
		},
	],
	isError: true as const,
	structuredContent: {
		ok: false as const,
		error: public_error_metadata(error),
	},
});
