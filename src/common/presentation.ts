import * as v from 'valibot';
import { handle_large_result } from './results.js';
import { store_result } from './result_store.js';
import { select_passages } from './passages.js';
import { get_response_metadata } from './response_metadata.js';
import { ErrorType, ProviderError } from './types.js';
import { LegacyRetentionError } from './errors.js';

export const presentation_schema = v.object({
	response_mode: v.optional(
		v.pipe(
			v.picklist(['legacy', 'compact', 'full']),
			v.description(
				'Opt-in presentation. Omitted/legacy preserves existing output; compact selects evidence; full retains complete evidence with pagination when needed.',
			),
		),
	),
	output_budget_bytes: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(2048),
			v.maxValue(80000),
			v.description(
				'UTF-8 byte cap for the serialized MCP tool result, including escaped content, excluding JSON-RPC framing. Compact/full only; defaults 12000/80000.',
			),
		),
	),
});
export interface PresentationOptions {
	response_mode?: 'legacy' | 'compact' | 'full';
	output_budget_bytes?: number;
	query?: string;
	provider: string;
	operation: string;
	elapsed_ms: number;
	urls?: string | string[];
	/** Measure the actual caller envelope; defaults to text-only MCP. */
	measure_bytes?: (value: unknown) => number;
}

// Remove only the exact, reconstructible concatenation. All other fields
// remain canonical, including provider metadata and meaningful URL queries.
export const canonical_result = (result: unknown): unknown => {
	if (!result || typeof result !== 'object' || Array.isArray(result))
		return result;
	const value = result as Record<string, unknown>;
	if (
		Array.isArray(value.raw_contents) &&
		value.raw_contents.length &&
		value.raw_contents.every(
			(item) => item && typeof item.content === 'string',
		) &&
		value.content ===
			value.raw_contents.map((item) => item.content).join('\n\n')
	) {
		const { content: _content, ...rest } = value;
		return rest;
	}
	return result;
};
export const tool_result_bytes = (value: unknown): number =>
	Buffer.byteLength(
		JSON.stringify({
			content: [
				{ type: 'text', text: JSON.stringify(value, null, 2) },
			],
		}),
		'utf8',
	);

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: {};
interface Source {
	id: string;
	url?: string;
	title?: string;
	text: string;
}
const sources_of = (
	result: unknown,
	urls?: string | string[],
): Source[] => {
	const value = object(result);
	if (Array.isArray(result))
		return result.map((item, index) => ({
			id: `/${index}/snippet`,
			url: typeof item.url === 'string' ? item.url : undefined,
			title: typeof item.title === 'string' ? item.title : undefined,
			text: typeof item.snippet === 'string' ? item.snippet : '',
		}));
	const sources: Source[] = Array.isArray(value.raw_contents)
		? value.raw_contents.map((item, index) => ({
				id: `/raw_contents/${index}/content`,
				url: typeof item.url === 'string' ? item.url : undefined,
				text: typeof item.content === 'string' ? item.content : '',
			}))
		: [];
	if (typeof value.content === 'string')
		sources.push({
			id: '/content',
			url:
				sources.length === 0
					? typeof urls === 'string'
						? urls
						: urls?.length === 1
							? urls[0]
							: undefined
					: undefined,
			title:
				typeof object(value.metadata).title === 'string'
					? (object(value.metadata).title as string)
					: undefined,
			text: value.content,
		});
	return sources;
};

export const validate_presentation = (
	options: Pick<
		PresentationOptions,
		'response_mode' | 'output_budget_bytes'
	>,
): void => {
	if (
		options.output_budget_bytes !== undefined &&
		(!options.response_mode || options.response_mode === 'legacy')
	)
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'output_budget_bytes requires response_mode=compact or full',
			'presentation',
			{ retryable: false },
		);
	if (!v.safeParse(presentation_schema, options).success)
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'Invalid presentation controls',
			'presentation',
			{ retryable: false },
		);
};

export const present_result = (
	result: unknown,
	options: PresentationOptions,
): unknown => {
	validate_presentation(options);
	const measure_bytes = options.measure_bytes ?? tool_result_bytes;
	if (!options.response_mode || options.response_mode === 'legacy') {
		try {
			return handle_large_result(result, options.operation, {
				force_storage: measure_bytes(result) > 80000,
			});
		} catch (error) {
			throw new LegacyRetentionError(error);
		}
	}
	const budget =
		options.output_budget_bytes ??
		(options.response_mode === 'compact' ? 12000 : 80000);
	const reported =
		result && typeof result === 'object'
			? get_response_metadata(result)
			: undefined;
	const failed_urls = object(object(result).metadata).failed_urls;
	const partial =
		Array.isArray(failed_urls) && failed_urls.length > 0;
	const warnings = partial
		? [
				'Provider reported failed sources; retained content includes successful sources only.',
			]
		: [];
	const full = {
		response_mode: options.response_mode,
		metadata: {
			provider: options.provider,
			operation: options.operation,
			elapsed_ms: options.elapsed_ms,
			...reported,
			usage: reported?.usage ?? null,
			usage_source: reported?.usage ? 'provider_reported' : 'unknown',
			local_completeness: 'complete',
			provider_partial: partial,
			provider_page_completeness: 'unknown',
		},
		...(warnings.length ? { warnings } : {}),
		result: canonical_result(result),
	};
	if (measure_bytes(full) <= budget) return full;
	// Always retain the entire normalized canonical result before selecting,
	// including results below the historical 80000-byte offload threshold.
	let stored;
	try {
		stored = store_result(JSON.stringify(full, null, 2));
	} catch {
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'Cannot retain complete canonical result; no evidence was returned',
			'presentation',
			{ retryable: false, cause: 'storage' },
		);
	}
	const retained = {
		response_mode: options.response_mode,
		metadata: { ...full.metadata, local_completeness: 'retained' },
		...(warnings.length ? { warnings } : {}),
		...stored,
		read_hint:
			'Call result_read; concatenate pages using next_offset and next_byte_offset as byte_offset to recover the complete canonical JSON.',
	};
	if (options.response_mode === 'full') {
		if (measure_bytes(retained) > budget)
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Output budget cannot fit required result provenance',
				'presentation',
				{ retryable: false },
			);
		return retained;
	}
	const sources = sources_of(
		full.result,
		['scrape', 'summarize', 'extract', 'contents'].includes(
			options.operation,
		)
			? options.urls
			: undefined,
	);
	// Budget the exact escaped MCP tool-result object, not just passage text.
	const compact = {
		...retained,
		metadata: {
			...retained.metadata,
			local_completeness: 'selected',
		},
		warnings: [
			...warnings,
			'Selected gateway evidence only; provider-omitted page content is not recoverable.',
		],
		offset_unit: 'utf16_code_units_in_canonical_source',
		source_count: sources.length,
		omitted_sources: 0,
		sources: [] as Array<
			Omit<Source, 'text'> & {
				selection_method: string;
				passages: Array<{ start: number; end: number; text: string }>;
				omitted: boolean;
			}
		>,
	};
	// Bound work independently of upstream result-count promises. Prefer a
	// smaller source-ordered subset with useful evidence over many empty
	// source identities. Geometric reduction avoids serializing every suffix.
	let count = Math.min(
		sources.length,
		Math.max(1, Math.floor(budget / 512)),
	);
	while (count > 0) {
		let allowance = Math.min(4000, Math.floor(budget / count));
		for (;;) {
			compact.sources = sources
				.slice(0, count)
				.map(({ text, ...source }) => {
					const selected = select_passages(
						text,
						options.query,
						allowance,
					);
					return {
						...source,
						selection_method: selected.method,
						passages: selected.passages,
						omitted: selected.omitted,
					};
				});
			compact.omitted_sources = sources.length - count;
			if (measure_bytes(compact) <= budget) return compact;
			if (allowance <= 64) break;
			allowance = Math.floor(allowance / 2);
		}
		count = Math.floor(count / 2);
	}
	compact.sources = [];
	compact.omitted_sources = sources.length;
	// With an expanded envelope, prefer a recoverable handle to an empty
	// selection. Text-only callers retain their existing compact shape.
	if (options.measure_bytes && measure_bytes(retained) <= budget)
		return retained;
	if (measure_bytes(compact) > budget) {
		if (measure_bytes(retained) <= budget) return retained;
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'Output budget cannot fit required result provenance',
			'presentation',
			{ retryable: false },
		);
	}
	return compact;
};
