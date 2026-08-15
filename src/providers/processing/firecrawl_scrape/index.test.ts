import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { FirecrawlScrapeProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.firecrawl_scrape.api_key;
const previous_base_url = config.processing.firecrawl_scrape.base_url;

describe('FirecrawlScrapeProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_scrape.api_key = 'fc-test-key';
		config.processing.firecrawl_scrape.base_url =
			'https://api.firecrawl.dev/v2/scrape';
	});

	afterEach(() => {
		config.processing.firecrawl_scrape.api_key = previous_api_key;
		config.processing.firecrawl_scrape.base_url = previous_base_url;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('keeps the default markdown scrape body', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: {
						markdown: 'Default markdown',
						metadata: { title: 'Example' },
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new FirecrawlScrapeProvider();
		const result = await provider.process_content(
			'https://example.com',
		);

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toEqual({
			url: 'https://example.com',
			formats: ['markdown'],
			onlyMainContent: true,
			waitFor: 2000,
		});
		expect(result.content).toBe('Default markdown');
		expect(result.metadata).toMatchObject({
			title: 'Example',
			urls_processed: 1,
			successful_extractions: 1,
		});
	});

	it('sends lockdown and cache controls when requested', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: { markdown: 'Cached markdown' },
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new FirecrawlScrapeProvider();
		await provider.process_content(
			'https://example.com',
			'advanced',
			{
				lockdown: true,
				maxAge: 1000,
				minAge: 1,
				storeInCache: false,
				removeBase64Images: true,
			},
		);

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			lockdown: true,
			maxAge: 1000,
			minAge: 1,
			storeInCache: false,
			removeBase64Images: true,
			waitFor: 5000,
		});
	});

	it('maps question and highlights options into Firecrawl format objects', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ success: true, data: { answer: 'Answer' } }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new FirecrawlScrapeProvider();
		await provider.process_content('https://example.com', 'basic', {
			question: 'What does this page say?',
		});
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body).formats,
		).toEqual([
			{ type: 'question', question: 'What does this page say?' },
		]);

		fetch_mock.mockClear();
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: { highlights: 'Key sentence' },
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);
		await provider.process_content('https://example.com', 'basic', {
			highlights_query: 'pricing',
		});
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body).formats,
		).toEqual([{ type: 'highlights', query: 'pricing' }]);
	});

	it('parses a document scrape returned as markdown with document metadata', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: {
						markdown: '# Annual report\n\nDocument body.',
						metadata: {
							title: 'Annual report',
							sourceURL: 'https://example.com/report.pdf',
							statusCode: 200,
							contentType: 'application/pdf',
						},
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const result =
			await new FirecrawlScrapeProvider().process_content(
				'https://example.com/report.pdf',
			);

		expect(result.content).toBe('# Annual report\n\nDocument body.');
		expect(result.metadata).toMatchObject({
			title: 'Annual report',
			urls_processed: 1,
			successful_extractions: 1,
		});
		expect(result.raw_contents).toEqual([
			{
				url: 'https://example.com/report.pdf',
				content: '# Annual report\n\nDocument body.',
			},
		]);
	});

	it('rejects conflicting scrape options before calling Firecrawl', async () => {
		const provider = new FirecrawlScrapeProvider();
		await expect(
			provider.process_content('https://example.com', 'basic', {
				question: 'Question?',
				highlights_query: 'query',
			}),
		).rejects.toThrow(
			'question and highlights_query cannot both be set',
		);
		await expect(
			provider.process_content('https://example.com', 'basic', {
				zeroDataRetention: true,
				storeInCache: true,
			}),
		).rejects.toThrow(
			'storeInCache cannot be true when zeroDataRetention is enabled',
		);
		await expect(
			provider.process_content('https://example.com', 'basic', {
				zeroDataRetention: true,
				onlyCleanContent: true,
			}),
		).rejects.toThrow(
			'onlyCleanContent is not supported with zeroDataRetention',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('does not automatically repeat a paid scrape after provider failure', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		fetch_mock.mockResolvedValue(
			new Response('temporary failure', { status: 503 }),
		);

		await expect(
			new FirecrawlScrapeProvider().process_content(
				'https://example.com',
			),
		).rejects.toThrow('Failed to extract content from all URLs');
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
