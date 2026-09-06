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

	it.each(['answer', 'highlights'])(
		'preserves nullable %s without fabricating page content',
		async (field) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({ success: true, data: { [field]: null } }),
				),
			);
			const result =
				await new FirecrawlScrapeProvider().process_content(
					'https://example.com',
					'basic',
					field === 'answer'
						? { question: 'Why?' }
						: { highlights_query: 'pricing' },
				);
			expect(result.content).toBe('');
			expect(result.metadata.documents).toEqual([
				{ url: 'https://example.com', [field]: null },
			]);
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);

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
		});
		expect(body.waitFor).toBeUndefined();
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

	it.each([
		{ formats: [{ type: 'json' }], data: { json: null } },
		{ formats: [{ type: 'json' }], data: { json: false } },
		{ formats: [{ type: 'json' }], data: { json: 0 } },
		{
			formats: ['screenshot'],
			data: { screenshot: 'https://images.test/page.png' },
		},
		{
			formats: ['markdown', 'screenshot', { type: 'json' }],
			data: {
				markdown: '# Page',
				screenshot: 'https://images.test/page.png',
				json: { items: [null, { active: false }] },
			},
		},
	])(
		'preserves every requested representation: $formats',
		async ({ formats, data }) => {
			fetch_mock.mockImplementation(
				async () =>
					new Response(JSON.stringify({ success: true, data })),
			);
			const result =
				await new FirecrawlScrapeProvider().process_content(
					'https://example.test',
					'basic',
					{ formats },
				);
			expect(result.metadata.documents).toEqual([
				{ url: 'https://example.test', ...data },
			]);
			expect(result.content.length).toBeGreaterThan(0);
		},
	);

	it('rejects unsupported formats instead of charging for discarded data', async () => {
		await expect(
			new FirecrawlScrapeProvider().process_content(
				'https://example.test',
				'basic',
				{ formats: ['unsupported-format'] },
			),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('rejects formats combined with shortcut questions rather than replacing formats', async () => {
		await expect(
			new FirecrawlScrapeProvider().process_content(
				'https://example.test',
				'basic',
				{ formats: ['screenshot'], question: 'Why?' },
			),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('aborts all workers and never drains the queue after a fatal response', async () => {
		vi.useFakeTimers();
		try {
			fetch_mock.mockImplementationOnce(
				async () =>
					new Response(JSON.stringify({ success: 'malformed' })),
			);
			fetch_mock.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve(
									new Response(
										JSON.stringify({
											success: true,
											data: { markdown: 'late' },
										}),
									),
								),
							50,
						),
					),
			);
			await expect(
				new FirecrawlScrapeProvider().process_content(
					Array.from(
						{ length: 20 },
						(_, i) => `https://example.test/${i}`,
					),
				),
			).rejects.toMatchObject({ details: { retryable: false } });
			await vi.advanceTimersByTimeAsync(1000);
			expect(fetch_mock).toHaveBeenCalledTimes(4);
			expect(
				fetch_mock.mock.calls.every(
					([, options]) => options.signal.aborted,
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops queued paid requests on 429 and retains Retry-After', async () => {
		vi.useFakeTimers();
		try {
			const reset_time = new Date(Date.now() + 60000);
			fetch_mock.mockImplementation(
				async () =>
					new Response('{}', {
						status: 429,
						headers: { 'Retry-After': '60' },
					}),
			);
			const pending = new FirecrawlScrapeProvider()
				.process_content(
					Array.from(
						{ length: 20 },
						(_, i) => `https://example.test/${i}`,
					),
				)
				.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(1);
			expect(fetch_mock).toHaveBeenCalledTimes(4);
			expect(await pending).toMatchObject({
				type: 'RATE_LIMIT',
				details: { status: 429, reset_time },
			});
			await vi.advanceTimersByTimeAsync(60000);
			expect(fetch_mock).toHaveBeenCalledTimes(4);
			expect(
				fetch_mock.mock.calls.every(
					([, options]) => options.signal.aborted,
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([401, 403, 404])(
		'stops the queue on permanent HTTP %s',
		async (status) => {
			fetch_mock.mockImplementation(
				async () => new Response('{}', { status }),
			);
			await expect(
				new FirecrawlScrapeProvider().process_content(
					Array.from(
						{ length: 20 },
						(_, i) => `https://example.test/${i}`,
					),
				),
			).rejects.toMatchObject({ details: { status } });
			expect(fetch_mock).toHaveBeenCalledTimes(4);
		},
	);

	it('never logs URLs or upstream messages on scrape failure', async () => {
		const log = vi
			.spyOn(console, 'error')
			.mockImplementation(() => {});
		fetch_mock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ success: false, error: 'private-echo' }),
				),
		);
		await expect(
			new FirecrawlScrapeProvider().process_content(
				'https://example.test/?token=private-url',
			),
		).rejects.toBeInstanceOf(Error);
		expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
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
