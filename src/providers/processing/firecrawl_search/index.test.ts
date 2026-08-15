import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { ErrorType } from '../../../common/types.js';
import { config } from '../../../config/env.js';
import { FirecrawlSearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.firecrawl_search.api_key;
const previous_base_url = config.processing.firecrawl_search.base_url;

describe('FirecrawlSearchProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_search.api_key = 'fc-test-key';
		config.processing.firecrawl_search.base_url =
			'https://api.firecrawl.dev/v2/search';
	});

	afterEach(() => {
		config.processing.firecrawl_search.api_key = previous_api_key;
		config.processing.firecrawl_search.base_url = previous_base_url;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('sends a v2 search request with compatible defaults', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					id: 'search-1',
					creditsUsed: 2,
					data: {
						web: [
							{
								title: 'Result',
								url: 'https://example.com',
								markdown: 'Example markdown',
							},
						],
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new FirecrawlSearchProvider();
		const result = await provider.process_content(
			'current search APIs',
		);

		const [url, options] = fetch_mock.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(url).toBe('https://api.firecrawl.dev/v2/search');
		expect(body).toEqual({
			query: 'current search APIs',
			limit: 5,
			sources: ['web'],
			scrapeOptions: {
				formats: ['markdown'],
				onlyMainContent: true,
			},
		});
		expect(result.content).toContain('Example markdown');
		expect(result.metadata).toMatchObject({
			search_id: 'search-1',
			creditsUsed: 2,
			source_counts: { web: 1, images: 0, news: 0 },
		});
	});

	it('passes documented v2 options and normalizes images and news', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					id: 'search-2',
					creditsUsed: 4,
					data: {
						web: [],
						images: [
							{
								title: 'Image result',
								url: 'https://example.com/image-page',
								imageUrl: 'https://example.com/image.png',
								imageWidth: 640,
								imageHeight: 480,
							},
						],
						news: [
							{
								title: 'News result',
								url: 'https://example.com/news',
								snippet: 'News snippet',
								date: '2026-06-17',
							},
						],
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new FirecrawlSearchProvider();
		const result = await provider.process_content(
			'agent search',
			'advanced',
			{
				limit: 7,
				sources: ['web', 'images', 'news'],
				categories: ['github', 'research'],
				country: 'US',
				location: 'San Francisco,California,United States',
				tbs: 'qdr:w',
				includeDomains: ['example.com'],
				ignoreInvalidURLs: true,
				scrapeOptions: { redactPII: true },
			},
		);

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			limit: 7,
			sources: ['web', 'images', 'news'],
			categories: ['github', 'research'],
			country: 'US',
			location: 'San Francisco,California,United States',
			tbs: 'qdr:w',
			includeDomains: ['example.com'],
			ignoreInvalidURLs: true,
			scrapeOptions: {
				formats: ['markdown'],
				onlyMainContent: true,
				redactPII: true,
			},
		});
		expect(result.content).toContain('News snippet');
		expect(result.content).toContain('https://example.com/image.png');
		expect(result.metadata.source_counts).toEqual({
			web: 0,
			images: 1,
			news: 1,
		});
	});

	it('parses current highlight and plain-description web results', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: {
						web: [
							{
								title: 'Highlighted result',
								url: 'https://example.com/highlights',
								description:
									'# Relevant heading\nRelevant highlighted passage.',
							},
							{
								title: 'Plain result',
								url: 'https://example.com/plain',
								description: 'Plain search description.',
								category: 'research',
							},
						],
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const result =
			await new FirecrawlSearchProvider().process_content(
				'academic websites',
				'basic',
				{
					categories: ['research'],
					scrapeOptions: { formats: [], onlyMainContent: false },
				},
			);

		expect(result.raw_contents).toEqual([
			{
				url: 'https://example.com/highlights',
				content: '# Relevant heading\nRelevant highlighted passage.',
			},
			{
				url: 'https://example.com/plain',
				content: 'Plain search description.',
			},
		]);
		expect(result.content).toContain('Category: research');
		expect(result.metadata.source_counts).toEqual({
			web: 2,
			images: 0,
			news: 0,
		});
	});

	it('rejects malformed web collections without exposing payload values', async () => {
		const sentinel = 'search-payload-secret-must-not-leak';
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: { web: { sentinel } },
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		let thrown: unknown;
		try {
			await new FirecrawlSearchProvider().process_content('query');
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl_search',
			message: 'Malformed firecrawl_search response',
			details: { retryable: false },
		});
		expect(JSON.stringify(thrown)).not.toContain(sentinel);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('rejects mutually exclusive domain filters', async () => {
		const provider = new FirecrawlSearchProvider();
		await expect(
			provider.process_content('query', 'basic', {
				includeDomains: ['example.com'],
				excludeDomains: ['example.org'],
			}),
		).rejects.toThrow(
			'includeDomains and excludeDomains cannot both be set',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});
