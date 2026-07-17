import {
	make_firecrawl_request,
	validate_firecrawl_response,
} from '../../../common/firecrawl_utils.js';
import {
	ErrorType,
	ProcessingProvider,
	ProcessingResult,
	ProviderError,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

type FirecrawlSearchSource = 'web' | 'images' | 'news';
type FirecrawlSearchCategory = 'github' | 'research' | 'pdf';

type FirecrawlSearchFormat =
	| string
	| {
			type: string;
			[key: string]: unknown;
	  };

export interface FirecrawlSearchOptions {
	limit?: number;
	sources?: FirecrawlSearchSource[];
	categories?: FirecrawlSearchCategory[];
	includeDomains?: string[];
	excludeDomains?: string[];
	tbs?: string;
	location?: string;
	country?: string;
	ignoreInvalidURLs?: boolean;
	scrapeOptions?: {
		formats?: FirecrawlSearchFormat[];
		onlyMainContent?: boolean;
		redactPII?: boolean;
	};
}

interface FirecrawlWebResult {
	url: string;
	title?: string;
	markdown?: string;
	html?: string;
	rawHtml?: string;
	description?: string;
	category?: string;
	metadata?: Record<string, unknown>;
}

interface FirecrawlImageResult {
	url: string;
	title?: string;
	imageUrl?: string;
	imageWidth?: number;
	imageHeight?: number;
	position?: number;
}

interface FirecrawlNewsResult {
	url: string;
	title?: string;
	snippet?: string;
	date?: string;
	imageUrl?: string;
	position?: number;
	markdown?: string;
	html?: string;
	rawHtml?: string;
	metadata?: Record<string, unknown>;
}

interface FirecrawlSearchResponse {
	success: boolean;
	data?: {
		web?: FirecrawlWebResult[];
		images?: FirecrawlImageResult[];
		news?: FirecrawlNewsResult[];
	};
	warning?: string | null;
	id?: string;
	creditsUsed?: number;
	error?: string;
}

const normalize_options = (
	options?: Record<string, unknown>,
): FirecrawlSearchOptions => (options || {}) as FirecrawlSearchOptions;

const assert_domain_filters = (
	options: FirecrawlSearchOptions,
	provider_name: string,
) => {
	if (options.includeDomains?.length && options.excludeDomains?.length) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'includeDomains and excludeDomains cannot both be set',
			provider_name,
		);
	}
};

const build_search_body = (
	query: string,
	extract_depth: 'basic' | 'advanced',
	options: FirecrawlSearchOptions,
): Record<string, unknown> => {
	const body: Record<string, unknown> = {
		query,
		limit: options.limit ?? (extract_depth === 'advanced' ? 10 : 5),
		sources: options.sources?.length ? options.sources : ['web'],
		scrapeOptions: {
			formats: ['markdown'],
			onlyMainContent: true,
		},
	};

	if (options.categories?.length) body.categories = options.categories;
	if (options.includeDomains?.length)
		body.includeDomains = options.includeDomains;
	if (options.excludeDomains?.length)
		body.excludeDomains = options.excludeDomains;
	if (options.tbs) body.tbs = options.tbs;
	if (options.location) body.location = options.location;
	if (options.country) body.country = options.country;
	if (options.ignoreInvalidURLs !== undefined)
		body.ignoreInvalidURLs = options.ignoreInvalidURLs;
	if (options.scrapeOptions) {
		body.scrapeOptions = {
			...(body.scrapeOptions as Record<string, unknown>),
			...options.scrapeOptions,
		};
	}

	return body;
};

const web_content = (result: FirecrawlWebResult) =>
	result.markdown ||
	result.html ||
	result.rawHtml ||
	result.description ||
	'No content extracted';

const news_content = (result: FirecrawlNewsResult) =>
	result.markdown ||
	result.html ||
	result.rawHtml ||
	result.snippet ||
	'No content extracted';

const format_web_result = (result: FirecrawlWebResult) => {
	const title = result.title ? `## ${result.title}\n` : '';
	const category = result.category ? `Category: ${result.category}\n` : '';
	return `${title}Source: ${result.url}\n${category}\n${web_content(result)}`;
};

const format_news_result = (result: FirecrawlNewsResult) => {
	const title = result.title ? `## ${result.title}\n` : '';
	const date = result.date ? `Date: ${result.date}\n` : '';
	return `${title}Source: ${result.url}\n${date}\n${news_content(result)}`;
};

const format_image_result = (result: FirecrawlImageResult) => {
	const title = result.title ? `## ${result.title}\n` : '';
	const image = result.imageUrl ? `Image: ${result.imageUrl}\n` : '';
	const dimensions =
		result.imageWidth && result.imageHeight
			? `Dimensions: ${result.imageWidth}x${result.imageHeight}\n`
			: '';
	return `${title}Source: ${result.url}\n${image}${dimensions}`.trim();
};

export class FirecrawlSearchProvider implements ProcessingProvider {
	name = 'firecrawl_search';
	description =
		'Web search combined with content scraping in a single call using Firecrawl v2. Returns normalized web, image, and news search results with optional scraped content.';

	async process_content(
		query: string | string[],
		extract_depth: 'basic' | 'advanced' = 'basic',
		options?: Record<string, unknown>,
	): Promise<ProcessingResult> {
		const search_query = Array.isArray(query) ? query[0] : query;

		if (!search_query || search_query.trim().length === 0) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Search query is required',
				this.name,
			);
		}

		const search_options = normalize_options(options);
		assert_domain_filters(search_options, this.name);

		const search_request = async () => {
			const api_key = validate_api_key(
				config.processing.firecrawl_search.api_key,
				this.name,
			);

			try {
				const request_body = build_search_body(
					search_query,
					extract_depth,
					search_options,
				);

				const data = await make_firecrawl_request<FirecrawlSearchResponse>(
					this.name,
					config.processing.firecrawl_search.base_url,
					api_key,
					request_body,
					config.processing.firecrawl_search.timeout,
				);

				validate_firecrawl_response(data, this.name, 'Search failed');

				if (Array.isArray(data.data)) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'Firecrawl returned legacy v1 search data for a v2 request',
						this.name,
					);
				}

				const web = data.data?.web || [];
				const images = data.data?.images || [];
				const news = data.data?.news || [];
				const total_results = web.length + images.length + news.length;

				if (total_results === 0) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'No search results returned',
						this.name,
					);
				}

				const raw_contents = [
					...web.map((result) => ({
						url: result.url,
						content: web_content(result),
					})),
					...news.map((result) => ({
						url: result.url,
						content: news_content(result),
					})),
					...images.map((result) => ({
						url: result.imageUrl || result.url,
						content: format_image_result(result),
					})),
				];

				const combined_content = [
					...web.map(format_web_result),
					...news.map(format_news_result),
					...images.map(format_image_result),
				].join('\n\n---\n\n');

				const word_count = combined_content
					.split(/\s+/)
					.filter(Boolean).length;

				return {
					content: combined_content,
					raw_contents,
					metadata: {
						word_count,
						urls_processed: total_results,
						successful_extractions: total_results,
						extract_depth,
						search_id: data.id,
						creditsUsed: data.creditsUsed,
						warning: data.warning,
						source_counts: {
							web: web.length,
							images: images.length,
							news: news.length,
						},
					},
					source_provider: this.name,
				};
			} catch (error) {
				handle_provider_error(error, this.name, 'search and extract');
			}
		};

		return retry_with_backoff(search_request);
	}
}

export const __private__ = {
	build_search_body,
};
