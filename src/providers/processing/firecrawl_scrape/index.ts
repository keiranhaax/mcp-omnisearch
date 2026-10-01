import * as v from 'valibot';
import { is_gone_status } from '../../../common/archive_fallback.js';
import {
	handle_provider_error,
	input_error,
} from '../../../common/errors.js';
import {
	make_firecrawl_request,
	create_firecrawl_budget,
	validate_firecrawl_formats,
	validate_firecrawl_response,
} from '../../../common/firecrawl_utils.js';
import {
	aggregate_url_results,
	type ProcessedUrlResult,
} from '../../../common/results.js';
import {
	is_non_retryable_provider_error,
	is_retryable_error,
	retry_with_backoff,
} from '../../../common/retry.js';
import {
	ErrorType,
	ProcessingProvider,
	ProcessingResult,
	ProviderError,
} from '../../../common/types.js';
import {
	validate_api_key,
	validate_processing_urls,
} from '../../../common/validation.js';
import { config } from '../../../config/env.js';
import { throw_if_aborted } from '../../../common/request_context.js';
import {
	sanitize_firecrawl_document,
	type SanitizedFirecrawlDocument,
} from '../../../common/provider_sanitization.js';

type FirecrawlScrapeFormat =
	| string
	| { type: string; [key: string]: unknown };

export interface FirecrawlScrapeOptions {
	formats?: FirecrawlScrapeFormat[];
	question?: string;
	highlights_query?: string;
	wait_for_ms?: number;
	lockdown?: boolean;
	maxAge?: number;
	minAge?: number;
	storeInCache?: boolean;
	zeroDataRetention?: boolean;
	redactPII?: boolean;
	onlyMainContent?: boolean;
	onlyCleanContent?: boolean;
	removeBase64Images?: boolean;
}

const firecrawl_scrape_response_schema = v.object({
	success: v.boolean(),
	data: v.optional(
		v.looseObject({
			markdown: v.optional(v.string()),
			summary: v.optional(v.string()),
			html: v.optional(v.string()),
			rawHtml: v.optional(v.string()),
			screenshot: v.optional(v.string()),
			answer: v.nullish(v.string()),
			highlights: v.nullish(v.string()),
			links: v.optional(v.array(v.string())),
			metadata: v.optional(v.unknown()),
			llm_extraction: v.optional(v.unknown()),
			warning: v.optional(v.unknown()),
		}),
	),
	error: v.optional(v.string()),
});

const normalize_options = (
	options?: Record<string, unknown>,
): FirecrawlScrapeOptions =>
	(options || {}) as FirecrawlScrapeOptions;

const assert_valid_options = (
	options: FirecrawlScrapeOptions,
	provider_name: string,
) => {
	for (const key of ['maxAge', 'minAge', 'wait_for_ms'] as const) {
		const value = options[key];
		if (
			value !== undefined &&
			(!Number.isSafeInteger(value) || value < 0)
		) {
			throw input_error(
				`${key} must be a nonnegative integer`,
				provider_name,
			);
		}
	}
	validate_firecrawl_formats(options.formats, provider_name);
	if (
		options.formats &&
		(options.question || options.highlights_query)
	) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'formats cannot be combined with question or highlights_query',
			provider_name,
		);
	}
	if (options.question && options.highlights_query) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'question and highlights_query cannot both be set',
			provider_name,
		);
	}
	if (options.zeroDataRetention && options.storeInCache === true) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'storeInCache cannot be true when zeroDataRetention is enabled',
			provider_name,
		);
	}
	if (options.zeroDataRetention && options.onlyCleanContent) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'onlyCleanContent is not supported with zeroDataRetention',
			provider_name,
		);
	}
};

const build_scrape_body = (
	url: string,
	extract_depth: 'basic' | 'advanced',
	options: FirecrawlScrapeOptions,
): Record<string, unknown> => {
	assert_valid_options(options, 'firecrawl_scrape');

	const body: Record<string, unknown> = {
		url,
		formats: options.formats?.length ? options.formats : ['markdown'],
		onlyMainContent: options.onlyMainContent ?? true,
	};

	if (options.wait_for_ms !== undefined && options.wait_for_ms > 0) {
		body.waitFor = Math.min(options.wait_for_ms, 15000);
	}

	if (options.question) {
		body.formats = [{ type: 'question', question: options.question }];
	}
	if (options.highlights_query) {
		body.formats = [
			{ type: 'highlights', query: options.highlights_query },
		];
	}

	for (const key of [
		'lockdown',
		'maxAge',
		'minAge',
		'storeInCache',
		'zeroDataRetention',
		'redactPII',
		'onlyCleanContent',
		'removeBase64Images',
	] as const) {
		if (options[key] !== undefined) body[key] = options[key];
	}

	return body;
};

// String representations promoted into `content` are removed from the
// per-URL document so a page is not retained twice; structured `json`
// and `links` stay because `content` only holds a rendering of them.
const promotable_fields = [
	'markdown',
	'summary',
	'answer',
	'highlights',
	'html',
	'rawHtml',
] as const;
type PromotableField = (typeof promotable_fields)[number];

const extract_content = (
	data: SanitizedFirecrawlDocument,
): { content: string; promoted?: PromotableField } => {
	if (!data) return { content: '' };
	for (const field of promotable_fields) {
		const value = data[field];
		if (value) return { content: value, promoted: field };
	}
	if (data.links?.length) return { content: data.links.join('\n') };
	if (Object.hasOwn(data, 'json'))
		return { content: JSON.stringify(data.json, null, 2) };
	if (data.screenshot) return { content: data.screenshot };
	return { content: '' };
};

const document_without_content = (
	document: SanitizedFirecrawlDocument,
	promoted: PromotableField | undefined,
) => {
	if (!promoted) return document;
	const { [promoted]: _content, ...rest } = document;
	return { ...rest, content_format: promoted };
};

export class FirecrawlScrapeProvider implements ProcessingProvider {
	name = 'firecrawl_scrape';
	description =
		'Extract clean, LLM-ready data from single URLs with enhanced formatting options using Firecrawl. Efficiently converts web content into markdown, plain text, or structured data with configurable extraction options. Best for content analysis, data collection, and AI training data preparation.';

	async process_content(
		url: string | string[],
		extract_depth: 'basic' | 'advanced' = 'basic',
		options?: Record<string, unknown>,
	): Promise<ProcessingResult> {
		const urls = validate_processing_urls(url, this.name);
		const scrape_options = normalize_options(options);
		assert_valid_options(scrape_options, this.name);

		const scrape_request = async () => {
			const api_key = validate_api_key(
				config.processing.firecrawl_scrape.api_key,
				this.name,
			);

			const budget = create_firecrawl_budget(
				config.processing.firecrawl_scrape.timeout,
			);
			const workers = new AbortController();
			const signal = AbortSignal.any([budget.signal, workers.signal]);
			try {
				const scrape_single = async (
					single_url: string,
				): Promise<ProcessedUrlResult> => {
					try {
						const data = await make_firecrawl_request(
							this.name,
							config.processing.firecrawl_scrape.base_url,
							api_key,
							build_scrape_body(
								single_url,
								extract_depth,
								scrape_options,
							),
							config.processing.firecrawl_scrape.timeout,
							firecrawl_scrape_response_schema,
							signal,
							// A scrape of the same URL with the same options is
							// an idempotent lookup.
							{ cacheable: true },
						);

						validate_firecrawl_response(
							data,
							this.name,
							'Error scraping URL',
						);

						if (!data.data) {
							throw new ProviderError(
								ErrorType.PROVIDER_ERROR,
								'No data returned from API',
								this.name,
							);
						}

						const document = sanitize_firecrawl_document(data.data);
						const { content, promoted } = extract_content(document);

						// A null answer/highlights is an explicit, valid "no match".
						const no_match =
							document.answer === null ||
							document.highlights === null;
						if (!content && !no_match) {
							throw new ProviderError(
								ErrorType.PROVIDER_ERROR,
								'No content extracted from URL',
								this.name,
							);
						}

						return {
							url: single_url,
							content,
							metadata: {
								...document.metadata,
								warning: document.warning,
								document: document_without_content(
									document,
									promoted,
								),
							},
							success: true,
						};
					} catch (error) {
						throw_if_aborted(signal);
						if (
							is_non_retryable_provider_error(error) ||
							(error instanceof ProviderError &&
								(error.type === ErrorType.RATE_LIMIT ||
									!is_retryable_error(error)))
						) {
							throw error;
						}
						return {
							url: single_url,
							content: '',
							success: false,
							error:
								error instanceof Error
									? error.message
									: 'Unknown error',
						};
					}
				};

				// Bounded concurrency: at most 4 simultaneous paid requests
				const concurrency = 4;
				const results: ProcessedUrlResult[] = Array.from({
					length: urls.length,
				});
				let next_index = 0;
				await Promise.all(
					Array.from(
						{ length: Math.min(concurrency, urls.length) },
						async () => {
							try {
								while (next_index < urls.length) {
									throw_if_aborted(signal);
									const i = next_index++;
									results[i] = await scrape_single(urls[i]);
								}
							} catch (error) {
								workers.abort();
								throw error;
							}
						},
					),
				);

				const result = aggregate_url_results(
					results,
					this.name,
					urls,
					extract_depth,
				);
				// Firecrawl reads a missing page like any other and reports
				// its status; a 404/410 body is listed as gone so the opt-in
				// archive fallback can replace it.
				const gone_urls = results
					.filter(
						(item) =>
							item.success &&
							is_gone_status(
								item.metadata?.document?.metadata?.statusCode,
							),
					)
					.map((item) => item.url);
				return {
					...result,
					metadata: {
						...result.metadata,
						...(gone_urls.length ? { gone_urls } : {}),
						documents: results
							.filter((item) => item.success)
							.map((item) => ({
								url: item.url,
								...item.metadata.document,
							})),
					},
				};
			} catch (error) {
				handle_provider_error(error, this.name, 'extract content');
			} finally {
				budget.dispose();
			}
		};

		return retry_with_backoff(scrape_request, { max_retries: 0 });
	}
}

export const __private__ = {
	build_scrape_body,
};
