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
});
