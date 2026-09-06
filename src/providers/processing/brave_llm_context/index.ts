import * as v from 'valibot';
import { parse_provider_response } from '../../../common/provider_response.js';
import { http_json } from '../../../common/http.js';
import {
	ErrorType,
	ProcessingResult,
	ProviderError,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

const context_result_schema = v.object({
	url: v.pipe(v.string(), v.trim(), v.minLength(1)),
	title: v.optional(v.string()),
	name: v.optional(v.string()),
	snippets: v.array(v.string()),
});
const context_response_schema = v.object({
	grounding: v.object({
		generic: v.optional(v.array(context_result_schema)),
		poi: v.nullish(context_result_schema),
		map: v.optional(v.array(context_result_schema)),
	}),
	sources: v.optional(
		v.record(
			v.string(),
			v.object({
				title: v.optional(v.string()),
				hostname: v.optional(v.string()),
				age: v.optional(v.array(v.string())),
			}),
		),
	),
});

export interface BraveLlmContextOptions {
	count?: number;
	maximum_number_of_urls?: number;
	maximum_number_of_tokens?: number;
	maximum_number_of_snippets?: number;
	context_threshold_mode?:
		| 'disabled'
		| 'strict'
		| 'lenient'
		| 'balanced';
	maximum_number_of_tokens_per_url?: number;
	maximum_number_of_snippets_per_url?: number;
	freshness?: string;
	country?: string;
	search_lang?: string;
	enable_local?: boolean;
	goggles?: string | string[];
	loc_lat?: number;
	loc_long?: number;
	loc_city?: string;
	loc_state?: string;
	loc_state_name?: string;
	loc_country?: string;
	loc_postal_code?: string;
}

const validate_location = (
	options: BraveLlmContextOptions | undefined,
) => {
	if (
		options?.loc_lat !== undefined &&
		(!Number.isFinite(options.loc_lat) ||
			options.loc_lat < -90 ||
			options.loc_lat > 90)
	) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'loc_lat must be between -90 and 90',
			'brave_llm_context',
		);
	}
	if (
		options?.loc_long !== undefined &&
		(!Number.isFinite(options.loc_long) ||
			options.loc_long < -180 ||
			options.loc_long > 180)
	) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'loc_long must be between -180 and 180',
			'brave_llm_context',
		);
	}
};

const build_location_headers = (
	options: BraveLlmContextOptions | undefined,
) => {
	const headers: Record<string, string> = {};
	if (!options) return headers;
	if (options.loc_lat !== undefined)
		headers['X-Loc-Lat'] = String(options.loc_lat);
	if (options.loc_long !== undefined)
		headers['X-Loc-Long'] = String(options.loc_long);
	if (options.loc_city) headers['X-Loc-City'] = options.loc_city;
	if (options.loc_state) headers['X-Loc-State'] = options.loc_state;
	if (options.loc_state_name)
		headers['X-Loc-State-Name'] = options.loc_state_name;
	if (options.loc_country)
		headers['X-Loc-Country'] = options.loc_country;
	if (options.loc_postal_code)
		headers['X-Loc-Postal-Code'] = options.loc_postal_code;
	return headers;
};

const bounded_integer = (value: number, min: number, max: number) => {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			`Value must be an integer between ${min} and ${max}`,
			'brave_llm_context',
		);
	}
	return value;
};

export class BraveLlmContextProvider {
	name = 'brave_llm_context';
	description =
		"Pre-extracted web content optimized for AI agents, LLM grounding, and RAG pipelines. Returns relevance-ranked content chunks from Brave's 30B+ page index. Powers 22M+ answers/day on Brave Search. Best for providing high-quality context to your own LLM.";

	async get_context(
		query: string,
		options?: BraveLlmContextOptions,
	): Promise<ProcessingResult> {
		if (!query || query.trim().length === 0) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Query is required for LLM context',
				this.name,
			);
		}

		validate_location(options);
		for (const [key, min, max] of [
			['count', 1, 50],
			['maximum_number_of_urls', 1, 50],
			['maximum_number_of_tokens', 1024, 32768],
			['maximum_number_of_snippets', 1, 256],
			['maximum_number_of_tokens_per_url', 512, 8192],
			['maximum_number_of_snippets_per_url', 1, 100],
		] as const) {
			if (options?.[key] !== undefined)
				bounded_integer(options[key], min, max);
		}

		const context_request = async () => {
			const api_key = validate_api_key(
				config.processing.brave_llm_context.api_key,
				this.name,
			);

			try {
				const request_body: Record<string, any> = {
					q: query.trim(),
				};

				if (options?.count !== undefined) {
					request_body.count = bounded_integer(options.count, 1, 50);
				}

				if (options?.maximum_number_of_urls !== undefined) {
					request_body.maximum_number_of_urls = bounded_integer(
						options.maximum_number_of_urls,
						1,
						50,
					);
				}

				if (options?.maximum_number_of_tokens !== undefined) {
					request_body.maximum_number_of_tokens = bounded_integer(
						options.maximum_number_of_tokens,
						1024,
						32768,
					);
				}

				if (options?.maximum_number_of_snippets !== undefined) {
					request_body.maximum_number_of_snippets = bounded_integer(
						options.maximum_number_of_snippets,
						1,
						256,
					);
				}

				if (options?.context_threshold_mode) {
					request_body.context_threshold_mode =
						options.context_threshold_mode;
				}

				if (options?.maximum_number_of_tokens_per_url !== undefined) {
					request_body.maximum_number_of_tokens_per_url =
						bounded_integer(
							options.maximum_number_of_tokens_per_url,
							512,
							8192,
						);
				}

				if (
					options?.maximum_number_of_snippets_per_url !== undefined
				) {
					request_body.maximum_number_of_snippets_per_url =
						bounded_integer(
							options.maximum_number_of_snippets_per_url,
							1,
							100,
						);
				}

				if (options?.freshness) {
					request_body.freshness = options.freshness;
				}

				if (options?.country) {
					request_body.country = options.country;
				}

				if (options?.search_lang) {
					request_body.search_lang = options.search_lang;
				}

				if (options?.enable_local !== undefined) {
					request_body.enable_local = options.enable_local;
				}

				if (options?.goggles) {
					request_body.goggles = options.goggles;
				}

				const location_headers = build_location_headers(options);

				const raw_response = await http_json(
					this.name,
					config.processing.brave_llm_context.base_url,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Accept: 'application/json',
							'X-Subscription-Token': api_key,
							...location_headers,
						},
						body: JSON.stringify(request_body),
						signal: AbortSignal.timeout(
							config.processing.brave_llm_context.timeout,
						),
					},
				);

				const response = parse_provider_response(
					this.name,
					context_response_schema,
					raw_response,
				);
				const results = [
					...(response.grounding.generic ?? []),
					...(response.grounding.poi ? [response.grounding.poi] : []),
					...(response.grounding.map ?? []),
				].filter((result) =>
					result.snippets.some((snippet) => snippet.trim()),
				);
				const sources = response.sources ?? {};

				if (results.length === 0) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'No context returned for query',
						this.name,
						{ retryable: false },
					);
				}

				const raw_contents: Array<{ url: string; content: string }> =
					[];

				for (const result of results) {
					const source = sources[result.url];
					const title =
						result.title ||
						result.name ||
						source?.title ||
						result.url;
					const header = `## ${title}\nSource: ${result.url}\n`;
					const body = result.snippets.join('\n\n');
					raw_contents.push({
						url: result.url,
						content: header + body,
					});
				}

				const combined_content = raw_contents
					.map((r) => r.content)
					.join('\n\n---\n\n');

				const word_count = combined_content
					.split(/\s+/)
					.filter(Boolean).length;

				return {
					content: combined_content,
					raw_contents,
					metadata: {
						word_count,
						urls_processed: results.length,
						successful_extractions: results.reduce(
							(sum, r) => sum + r.snippets.length,
							0,
						),
					},
					source_provider: this.name,
				};
			} catch (error) {
				handle_provider_error(error, this.name, 'fetch LLM context');
			}
		};

		return retry_with_backoff(context_request, {
			timeout_ms: config.processing.brave_llm_context.timeout,
		});
	}
}

export const __private__ = {
	build_location_headers,
	validate_location,
};
