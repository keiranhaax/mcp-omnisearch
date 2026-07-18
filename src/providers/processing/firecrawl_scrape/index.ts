import { handle_provider_error } from '../../../common/errors.js';
import {
	make_firecrawl_request,
	validate_firecrawl_response,
} from '../../../common/firecrawl_utils.js';
import {
	aggregate_url_results,
	type ProcessedUrlResult,
} from '../../../common/results.js';
import { retry_with_backoff } from '../../../common/retry.js';
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

type FirecrawlScrapeFormat =
	| string
	| { type: string; [key: string]: unknown };

export interface FirecrawlScrapeOptions {
	formats?: FirecrawlScrapeFormat[];
	question?: string;
	highlights_query?: string;
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

interface FirecrawlScrapeResponse {
	success: boolean;
	data?: {
		markdown?: string;
		summary?: string;
		html?: string;
		rawHtml?: string;
		screenshot?: string;
		answer?: string;
		highlights?: string;
		links?: string[];
		metadata?: {
			title?: string;
			description?: string;
			language?: string;
			sourceURL?: string;
			statusCode?: number;
			error?: string;
			[key: string]: any;
		};
		llm_extraction?: any;
		warning?: string;
	};
	error?: string;
}

const normalize_options = (
	options?: Record<string, unknown>,
): FirecrawlScrapeOptions =>
	(options || {}) as FirecrawlScrapeOptions;

const assert_valid_options = (
	options: FirecrawlScrapeOptions,
	provider_name: string,
) => {
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
		waitFor: extract_depth === 'advanced' ? 5000 : 2000,
	};

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

const extract_content = (data: FirecrawlScrapeResponse['data']) => {
	if (!data) return '';
	if (data.markdown) return data.markdown;
	if (data.summary) return data.summary;
	if (data.answer) return data.answer;
	if (data.highlights) return data.highlights;
	if (data.html) return data.html;
	if (data.rawHtml) return data.rawHtml;
	if (data.links?.length) return data.links.join('\n');
	return '';
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

			try {
				const results: ProcessedUrlResult[] = await Promise.all(
					urls.map(async (single_url) => {
						try {
							const data =
								await make_firecrawl_request<FirecrawlScrapeResponse>(
									this.name,
									config.processing.firecrawl_scrape.base_url,
									api_key,
									build_scrape_body(
										single_url,
										extract_depth,
										scrape_options,
									),
									config.processing.firecrawl_scrape.timeout,
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

							const content = extract_content(data.data);

							if (!content) {
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
									...data.data.metadata,
									warning: data.data.warning,
								},
								success: true,
							};
						} catch (error) {
							console.error(`Error processing ${single_url}:`, error);
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
					}),
				);

				return aggregate_url_results(
					results,
					this.name,
					urls,
					extract_depth,
				);
			} catch (error) {
				handle_provider_error(error, this.name, 'extract content');
			}
		};

		return retry_with_backoff(scrape_request, { max_retries: 0 });
	}
}

export const __private__ = {
	build_scrape_body,
};
