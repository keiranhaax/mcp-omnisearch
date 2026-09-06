import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { FirecrawlCrawlProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.firecrawl_crawl.api_key;
const previous_base_url = config.processing.firecrawl_crawl.base_url;

const json_response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});

describe('FirecrawlCrawlProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		vi.useFakeTimers();
		config.processing.firecrawl_crawl.api_key = 'fc-test-key';
		config.processing.firecrawl_crawl.base_url =
			'https://api.firecrawl.dev/v2/crawl';
	});

	afterEach(() => {
		config.processing.firecrawl_crawl.api_key = previous_api_key;
		config.processing.firecrawl_crawl.base_url = previous_base_url;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('uses maxDiscoveryDepth and parses current status page shapes', async () => {
		fetch_mock
			.mockResolvedValueOnce(
				json_response({
					success: true,
					id: 'crawl-1',
					url: 'https://api.firecrawl.dev/v2/crawl/crawl-1',
				}),
			)
			.mockResolvedValueOnce(
				json_response({
					status: 'completed',
					total: 2,
					completed: 2,
					data: [
						{
							markdown: '# First page',
							metadata: {
								title: 'First page',
								sourceURL: 'https://example.com/first',
							},
						},
						{
							html: null,
							rawHtml: null,
							metadata: {
								url: 'https://example.com/failed',
								error: 'blocked',
							},
						},
					],
				}),
			);

		const promise = new FirecrawlCrawlProvider().process_content(
			'https://example.com',
			'advanced',
		);
		await vi.advanceTimersByTimeAsync(5000);
		const result = await promise;

		const start_body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(start_body).toMatchObject({
			maxDiscoveryDepth: 3,
			limit: 50,
		});
		expect(start_body).not.toHaveProperty('maxDepth');
		expect(result.raw_contents).toEqual([
			{
				url: 'https://example.com/first',
				content: '# First page',
			},
		]);
		expect(result.metadata.failed_urls).toEqual([
			'https://example.com/failed',
		]);
	});

	it('reports failed pages without a URL as unknown instead of the crawl root', async () => {
		fetch_mock
			.mockResolvedValueOnce(
				json_response({ success: true, id: 'crawl-2' }),
			)
			.mockResolvedValueOnce(
				json_response({
					status: 'completed',
					data: [
						{
							markdown: '# First page',
							metadata: {
								sourceURL: 'https://example.com/first',
							},
						},
						{ error: 'blocked' },
					],
				}),
			);

		const promise = new FirecrawlCrawlProvider().process_content(
			'https://example.com',
		);
		await vi.advanceTimersByTimeAsync(5000);
		const result = await promise;

		expect(result.metadata.failed_urls).toEqual(['(unknown url)']);
	});

	it('follows completed crawl pagination while retaining provider totals', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({ success: true, id: 'paged' }),
		);
		fetch_mock.mockImplementationOnce(async () =>
			json_response({
				status: 'completed',
				total: 2,
				completed: 2,
				data: [
					{
						markdown: 'first',
						metadata: { sourceURL: 'https://example.test/1' },
					},
				],
				next: 'https://api.firecrawl.dev/v2/crawl/paged?skip=1',
			}),
		);
		fetch_mock.mockImplementationOnce(async () =>
			json_response({
				status: 'completed',
				total: 2,
				completed: 2,
				data: [
					{
						markdown: 'second',
						metadata: { sourceURL: 'https://example.test/2' },
					},
				],
				next: null,
			}),
		);
		const promise = new FirecrawlCrawlProvider().process_content(
			'https://example.test',
		);
		await vi.advanceTimersByTimeAsync(5000);
		const result = await promise;
		expect(result.raw_contents?.map((page) => page.content)).toEqual([
			'first',
			'second',
		]);
		expect(result.metadata).toMatchObject({
			total: 2,
			completed: 2,
			returned_pages: 2,
			truncated: false,
			next: null,
		});
		expect(fetch_mock.mock.calls[2][0]).toBe(
			'https://api.firecrawl.dev/v2/crawl/paged?skip=1',
		);
		expect(fetch_mock.mock.calls[2][1].redirect).toBe('error');
	});

	it.each([
		'https://outside.test/v2/crawl/paged',
		'https://api.firecrawl.dev/v2/agent/paged',
		'https://user:password@api.firecrawl.dev/v2/crawl/paged',
	])(
		'rejects an unsafe continuation %s before sending credentials',
		async (next) => {
			fetch_mock.mockImplementationOnce(async () =>
				json_response({ success: true, id: 'paged' }),
			);
			fetch_mock.mockImplementationOnce(async () =>
				json_response({
					status: 'completed',
					data: [{ markdown: 'first' }],
					next,
				}),
			);
			const promise = new FirecrawlCrawlProvider()
				.process_content('https://example.test')
				.catch((error) => error);
			await vi.advanceTimersByTimeAsync(5000);
			expect(await promise).toMatchObject({
				type: 'PROVIDER_ERROR',
				details: { retryable: false },
			});
			expect(fetch_mock).toHaveBeenCalledTimes(2);
		},
	);

	it.each(['failed', 'error', 'cancelled', 'processing', 'scraping'])(
		'rejects a %s continuation instead of reporting complete results',
		async (status) => {
			fetch_mock
				.mockResolvedValueOnce(
					json_response({ success: true, id: 'paged' }),
				)
				.mockResolvedValueOnce(
					json_response({
						status: 'completed',
						total: 2,
						completed: 2,
						data: [{ markdown: 'first' }],
						next: 'https://api.firecrawl.dev/v2/crawl/paged?skip=1',
					}),
				)
				.mockResolvedValueOnce(json_response({ status }));
			const promise = new FirecrawlCrawlProvider()
				.process_content('https://example.test')
				.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(5000);
			expect(await promise).toMatchObject({
				type: 'PROVIDER_ERROR',
				message: 'Crawl pagination did not complete',
				details: { retryable: false },
			});
			expect(fetch_mock).toHaveBeenCalledTimes(3);
		},
	);

	it('bounds pagination with an honest continuation instead of claiming completion', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({ success: true, id: 'paged' }),
		);
		let page = 0;
		fetch_mock.mockImplementation(async () =>
			json_response({
				status: 'completed',
				total: 100,
				completed: 100,
				data: [{ markdown: `page ${++page}` }],
				next: `https://api.firecrawl.dev/v2/crawl/paged?skip=${page}`,
			}),
		);
		const promise = new FirecrawlCrawlProvider().process_content(
			'https://example.test',
		);
		await vi.advanceTimersByTimeAsync(5000);
		const result = await promise;
		expect(result.metadata).toMatchObject({
			total: 100,
			completed: 100,
			returned_pages: 10,
			truncated: true,
			next: 'https://api.firecrawl.dev/v2/crawl/paged?skip=10',
			truncation_reason: 'page_limit',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(11);
	});

	it('times out when the crawl never completes', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({ success: true, id: 'crawl-3' }),
		);
		fetch_mock.mockImplementation(async () =>
			json_response({ status: 'scraping' }),
		);

		const promise = new FirecrawlCrawlProvider().process_content(
			'https://example.com',
		);
		const rejection = expect(promise).rejects.toMatchObject({
			provider: 'firecrawl_crawl',
			message:
				'Job timed out - try again later or with a smaller scope',
		});

		await vi.advanceTimersByTimeAsync(20 * 5000);
		await rejection;
		// One start request plus 20 poll attempts.
		expect(fetch_mock).toHaveBeenCalledTimes(21);
	});
});
