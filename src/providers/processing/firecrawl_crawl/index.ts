import * as v from 'valibot';
import { handle_provider_error } from '../../../common/errors.js';
import {
	firecrawl_poll_status_schema,
	create_firecrawl_budget,
	make_firecrawl_request,
	poll_firecrawl_job,
	validate_firecrawl_response,
} from '../../../common/firecrawl_utils.js';
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
import { http_json } from '../../../common/http.js';
import { parse_provider_response } from '../../../common/provider_response.js';

const firecrawl_crawl_start_schema = v.object({
	success: v.boolean(),
	id: v.string(),
	url: v.optional(v.string()),
	error: v.optional(v.string()),
});

const firecrawl_crawl_status_schema = v.object({
	success: v.optional(v.boolean()),
	status: firecrawl_poll_status_schema,
	total: v.optional(v.number()),
	completed: v.optional(v.number()),
	next: v.nullish(v.string()),
	data: v.optional(
		v.array(
			v.object({
				url: v.optional(v.string()),
				markdown: v.optional(v.nullable(v.string())),
				html: v.optional(v.nullable(v.string())),
				rawHtml: v.optional(v.nullable(v.string())),
				metadata: v.optional(v.record(v.string(), v.unknown())),
				error: v.optional(v.nullable(v.string())),
			}),
		),
	),
	error: v.optional(v.string()),
});

const get_firecrawl_page_url = (
	page: {
		url?: string;
		metadata?: Record<string, unknown>;
	},
	fallback_url: string,
) => {
	const metadata_url = page.metadata?.sourceURL ?? page.metadata?.url;
	return (
		page.url ??
		(typeof metadata_url === 'string' ? metadata_url : fallback_url)
	);
};

const get_firecrawl_page_error = (page: {
	error?: string | null;
	metadata?: Record<string, unknown>;
}) => {
	const metadata_error = page.metadata?.error;
	return (
		page.error ??
		(typeof metadata_error === 'string' ? metadata_error : undefined)
	);
};

export class FirecrawlCrawlProvider implements ProcessingProvider {
	name = 'firecrawl_crawl';
	description =
		'Deep crawling of all accessible subpages on a website with configurable depth limits using Firecrawl. Efficiently discovers and extracts content from multiple pages within a domain. Best for comprehensive site analysis, content indexing, and data collection from entire websites.';

	async process_content(
		url: string | string[],
		extract_depth: 'basic' | 'advanced' = 'basic',
	): Promise<ProcessingResult> {
		// Crawl only works with a single URL (the starting point)
		const urls = validate_processing_urls(url, this.name);
		const crawl_url = urls[0];

		const crawl_request = async () => {
			const api_key = validate_api_key(
				config.processing.firecrawl_crawl.api_key,
				this.name,
			);

			const budget = create_firecrawl_budget(
				config.processing.firecrawl_crawl.timeout,
			);
			try {
				// Start the crawl
				const crawl_data = await make_firecrawl_request(
					this.name,
					config.processing.firecrawl_crawl.base_url,
					api_key,
					{
						url: crawl_url,
						scrapeOptions: {
							formats: ['markdown'],
							onlyMainContent: true,
						},
						maxDiscoveryDepth: extract_depth === 'advanced' ? 3 : 1,
						limit: extract_depth === 'advanced' ? 50 : 20,
					},
					config.processing.firecrawl_crawl.timeout,
					firecrawl_crawl_start_schema,
					budget.signal,
				);

				validate_firecrawl_response(
					crawl_data,
					this.name,
					'Error starting crawl',
				);

				const status_url = `${config.processing.firecrawl_crawl.base_url}/${encodeURIComponent(crawl_data.id)}`;
				// Poll for crawl completion
				const status_data = await poll_firecrawl_job(
					{
						provider_name: this.name,
						status_url,
						api_key,
						max_attempts: 20,
						poll_interval: 5000,
						timeout: 30000,
						signal: budget.signal,
					},
					firecrawl_crawl_status_schema,
				);

				const pages = [...(status_data.data ?? [])];
				let next = status_data.next ?? null;
				let page_count = 1;
				while (next) {
					let continuation: URL;
					try {
						continuation = new URL(next, status_url);
					} catch {
						throw new ProviderError(
							ErrorType.PROVIDER_ERROR,
							'Invalid crawl continuation URL',
							this.name,
							{ retryable: false },
						);
					}
					const expected = new URL(status_url);
					if (
						continuation.origin !== expected.origin ||
						continuation.pathname !== expected.pathname ||
						continuation.username ||
						continuation.password ||
						continuation.hash
					) {
						throw new ProviderError(
							ErrorType.PROVIDER_ERROR,
							'Unsafe crawl continuation URL',
							this.name,
							{ retryable: false },
						);
					}
					next = continuation.href;
					if (page_count >= 10) break;
					const raw = await http_json(this.name, next, {
						method: 'GET',
						headers: { Authorization: `Bearer ${api_key}` },
						signal: budget.signal,
						redirect: 'error',
					});
					const page = parse_provider_response(
						this.name,
						firecrawl_crawl_status_schema,
						raw,
					);
					validate_firecrawl_response(
						page,
						this.name,
						'Crawl pagination failed',
					);
					if (page.status !== 'completed') {
						throw new ProviderError(
							ErrorType.PROVIDER_ERROR,
							'Crawl pagination did not complete',
							this.name,
							{ retryable: false },
						);
					}
					pages.push(...(page.data ?? []));
					page_count++;
					next = page.next ?? null;
				}
				status_data.data = pages;
				// Verify we have data
				if (!status_data.data || status_data.data.length === 0) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'Crawl returned no data',
						this.name,
					);
				}

				// Filter out failed pages
				const successful_pages = status_data.data.filter(
					(page) =>
						!get_firecrawl_page_error(page) &&
						(page.markdown || page.html || page.rawHtml),
				);

				if (successful_pages.length === 0) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'All crawled pages failed to extract content',
						this.name,
					);
				}

				// Map results to raw_contents array
				const raw_contents = successful_pages.map((page) => ({
					url: get_firecrawl_page_url(page, crawl_url),
					content: page.markdown || page.html || page.rawHtml || '',
				}));

				// Combine all results into a single content string
				const combined_content = raw_contents
					.map(
						(result) =>
							`# ${result.url}\n\n${result.content}\n\n---\n\n`,
					)
					.join('\n\n');

				// Calculate total word count
				const word_count = combined_content
					.split(/\s+/)
					.filter(Boolean).length;

				// Get title from first successful result if available
				const title_value = successful_pages[0]?.metadata?.title;
				const title =
					typeof title_value === 'string' ? title_value : undefined;

				// Track failed URLs; never fall back to the crawl root here,
				// which would misreport the root itself as failed.
				const failed_urls = status_data.data
					.filter((page) => get_firecrawl_page_error(page))
					.map((page) =>
						get_firecrawl_page_url(page, '(unknown url)'),
					);

				return {
					content: combined_content,
					raw_contents,
					metadata: {
						title,
						word_count,
						failed_urls:
							failed_urls.length > 0 ? failed_urls : undefined,
						urls_processed:
							status_data.completed ?? status_data.data.length,
						total: status_data.total,
						completed: status_data.completed,
						returned_pages: status_data.data.length,
						truncated: next !== null,
						next,
						truncation_reason: next ? 'page_limit' : undefined,
						successful_extractions: successful_pages.length,
						extract_depth,
					},
					source_provider: this.name,
				};
			} catch (error) {
				handle_provider_error(error, this.name, 'crawl website');
			} finally {
				budget.dispose();
			}
		};

		return retry_with_backoff(crawl_request, { max_retries: 0 });
	}
}
