import * as v from 'valibot';
import { select_passages } from './passages.js';
import { store_result } from './result_store.js';
import { ErrorType, ProviderError } from './types.js';

const metadata_schema = v.looseObject({
	search_provider: v.string(),
	extract_provider: v.string(),
	http_requests: v.number(),
	complete: v.boolean(),
	considered_hits: v.optional(v.number()),
	duplicates_removed: v.optional(v.number()),
	sources_omitted: v.optional(v.number()),
	max_requests: v.optional(v.number()),
	max_sources: v.optional(v.number()),
	search_limit: v.optional(v.number()),
	elapsed_ms: v.optional(v.number()),
	search_request_metadata: v.optional(
		v.nullable(v.record(v.string(), v.unknown())),
	),
});
const source_schema = v.looseObject({
	id: v.string(),
	url: v.optional(v.string()),
	title: v.optional(v.string()),
	snippet: v.optional(v.string()),
	status: v.picklist(['ok', 'error', 'skipped']),
	content: v.optional(v.string()),
	search_provider: v.string(),
	extract_provider: v.string(),
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
				'upstream_failure',
				'request_budget',
			]),
			retryable: v.boolean(),
			provider: v.optional(v.string()),
			http_status: v.optional(v.number()),
		}),
	),
	passages: v.optional(
		v.array(
			v.object({
				start: v.number(),
				end: v.number(),
				text: v.string(),
			}),
		),
	),
	selection_method: v.optional(v.string()),
	omitted: v.optional(v.boolean()),
	extraction: v.optional(
		v.looseObject({
			content: v.string(),
			source_provider: v.string(),
			metadata: v.record(v.string(), v.unknown()),
			raw_contents: v.optional(
				v.array(v.object({ url: v.string(), content: v.string() })),
			),
		}),
	),
	request_metadata: v.optional(
		v.nullable(v.record(v.string(), v.unknown())),
	),
});
export const search_read_data_schema = v.variant('presentation', [
	v.object({
		presentation: v.literal('complete'),
		sources: v.array(source_schema),
		metadata: metadata_schema,
	}),
	v.object({
		presentation: v.literal('selected'),
		sources: v.array(source_schema),
		metadata: metadata_schema,
		result_id: v.string(),
		total_lines: v.number(),
		expires_at: v.string(),
		read_hint: v.string(),
		offset_unit: v.literal('utf16_code_units_in_canonical_source'),
	}),
	v.object({
		presentation: v.literal('retained'),
		metadata: metadata_schema,
		result_id: v.string(),
		total_lines: v.number(),
		expires_at: v.string(),
		read_hint: v.string(),
	}),
]);
export type SearchReadResult = {
	presentation: 'complete';
	sources: Array<v.InferOutput<typeof source_schema>>;
	metadata: v.InferOutput<typeof metadata_schema>;
};

// The injected renderer budgets the exact client-visible envelope.
export const present_search_read = (
	result: SearchReadResult,
	query: string,
	budget: number,
	measure: (value: unknown) => number,
): unknown => {
	if (measure(result) <= budget) return result;
	let stored;
	try {
		stored = store_result(JSON.stringify(result, null, 2));
	} catch {
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'Cannot retain complete canonical result; no evidence was returned',
			'presentation',
			{ retryable: false, cause: 'storage' },
		);
	}
	const retained = {
		presentation: 'retained',
		...stored,
		metadata: {
			search_provider: result.metadata.search_provider,
			extract_provider: result.metadata.extract_provider,
			http_requests: result.metadata.http_requests,
			complete: result.metadata.complete,
		},
		read_hint:
			'Read complete canonical JSON with result_read; follow next_offset and next_byte_offset.',
	};
	for (
		let allowance = Math.min(
			2000,
			Math.floor(budget / Math.max(1, result.sources.length)),
		);
		allowance >= 64;
		allowance = Math.floor(allowance / 2)
	) {
		const selected = {
			...retained,
			presentation: 'selected',
			offset_unit: 'utf16_code_units_in_canonical_source',
			sources: result.sources.map((source) => {
				const {
					content,
					extraction: _extraction,
					snippet: _snippet,
					request_metadata: _metadata,
					...identity
				} = source;
				const passages = select_passages(
					content ?? '',
					query,
					allowance,
				);
				return {
					...identity,
					selection_method: passages.method,
					passages: passages.passages,
					omitted: passages.omitted,
				};
			}),
		};
		if (measure(selected) <= budget) return selected;
	}
	if (measure(retained) <= budget) return retained;
	throw new ProviderError(
		ErrorType.INVALID_INPUT,
		'Output budget cannot fit required result provenance',
		'presentation',
		{ retryable: false },
	);
};
