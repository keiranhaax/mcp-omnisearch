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

interface BraveLlmContextSource {
	title?: string;
	hostname?: string;
	age?: string[];
}

interface BraveLlmContextGenericResult {
	url: string;
	title: string;
	snippets: string[];
}

interface BraveLlmContextGrounding {
	generic?: BraveLlmContextGenericResult[];
	map?: any[];
}

interface BraveLlmContextResponse {
	grounding: BraveLlmContextGrounding;
	sources: Record<string, BraveLlmContextSource>;
}

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
		(options.loc_lat < -90 || options.loc_lat > 90)
	) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'loc_lat must be between -90 and 90',
			'brave_llm_context',
		);
	}
	if (
		options?.loc_long !== undefined &&
		(options.loc_long < -180 || options.loc_long > 180)
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

const clamp_integer = (value: number, min: number, max: number) =>
	Math.min(Math.max(Math.trunc(value), min), max);

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
					request_body.count = clamp_integer(options.count, 1, 50);
				}

				if (options?.maximum_number_of_urls !== undefined) {
					request_body.maximum_number_of_urls = clamp_integer(
						options.maximum_number_of_urls,
						1,
						50,
					);
				}

				if (options?.maximum_number_of_tokens !== undefined) {
					request_body.maximum_number_of_tokens = clamp_integer(
						options.maximum_number_of_tokens,
						1024,
						32768,
					);
				}

				if (options?.maximum_number_of_snippets !== undefined) {
					request_body.maximum_number_of_snippets = clamp_integer(
						options.maximum_number_of_snippets,
						1,
						100,
					);
				}

				if (options?.context_threshold_mode) {
					request_body.context_threshold_mode =
						options.context_threshold_mode;
				}

				if (options?.maximum_number_of_tokens_per_url !== undefined) {
					request_body.maximum_number_of_tokens_per_url =
						clamp_integer(
							options.maximum_number_of_tokens_per_url,
							512,
							8192,
						);
				}

				if (
					options?.maximum_number_of_snippets_per_url !== undefined
				) {
					request_body.maximum_number_of_snippets_per_url =
						clamp_integer(
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

				const response = await http_json<BraveLlmContextResponse>(
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

				const results = response.grounding?.generic || [];
				const sources = response.sources || {};

				if (results.length === 0) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'No context returned for query',
						this.name,
					);
				}

				const raw_contents: Array<{ url: string; content: string }> =
					[];

				for (const result of results) {
					const source = sources[result.url];
					const title = result.title || source?.title || result.url;
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

		return retry_with_backoff(context_request);
	}
}

export const __private__ = {
	build_location_headers,
	validate_location,
};
