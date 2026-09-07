import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { get_response_metadata } from '../../../common/response_metadata.js';
import { ExaContentsProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.exa_contents.api_key;

describe('ExaContentsProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.exa_contents.api_key = 'exa-test-key';
	});

	afterEach(() => {
		config.processing.exa_contents.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each([-1, 404.5, '404', 1e100])(
		'sanitizes status controls while keeping source IDs and content: %j',
		async (httpStatusCode) => {
			const url = 'https://example.com/docs?token=syntax&q=a%2Bb';
			const content =
				'~~~js\nconst api_key = "example";\n~~~ $x^2$ [1]';
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						requestId: 'Bearer CONTROL_CANARY',
						results: [
							{ id: 'doc:1', url: url + '&page=1', text: content },
						],
						statuses: [
							{
								id: 'doc:1',
								status: 'success',
								source: 'cached',
								error: null,
							},
							{
								id: url,
								status: 'error',
								error: {
									tag: 'Bearer CONTROL_CANARY',
									httpStatusCode,
									headers: { authorization: 'CONTROL_CANARY' },
								},
								config: { api_key: 'CONTROL_CANARY' },
							},
						],
						costDollars: { total: { config: 'CONTROL_CANARY' } },
					}),
				),
			);
			const result = await new ExaContentsProvider().process_content([
				'doc-1',
				'doc-2',
			]);
			expect(JSON.stringify(result)).not.toContain('CONTROL_CANARY');
			expect(result.raw_contents).toEqual([
				{ url: url + '&page=1', content },
			]);
			expect(result.metadata.requestId).toBeUndefined();
			expect(get_response_metadata(result)).toBeUndefined();
			expect(result.metadata.statuses).toEqual([
				{
					id: 'doc:1',
					status: 'success',
					source: 'cached',
					error: null,
				},
				{ id: url, status: 'error', error: {} },
			]);
			expect(result.metadata.failed_urls).toEqual([url]);
		},
	);

	it('attaches safe response metadata to the root object', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-usage',
					costDollars: { total: 0.001 },
					results: [
						{
							id: 'doc-1',
							url: 'https://example.com',
							text: 'source',
						},
					],
				}),
			),
		);
		const result = await new ExaContentsProvider().process_content(
			'doc-1',
		);
		expect(get_response_metadata(result)).toEqual({
			request_id: 'req-usage',
			usage: { usd: 0.001 },
		});
		expect(
			get_response_metadata(result.raw_contents![0]),
		).toBeUndefined();
	});

	it.each([
		{
			results: [],
			statuses: [
				{
					id: 'doc-1',
					status: 'error',
					error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 },
				},
			],
		},
		{
			results: [
				{
					id: 'doc-1',
					url: 'https://example.com',
					text: null,
					summary: null,
					highlights: [],
				},
			],
		},
	])(
		'rejects all-failed or contentless responses without retrying: %o',
		async (body) => {
			fetch_mock.mockImplementation(
				async () => new Response(JSON.stringify(body)),
			);
			await expect(
				new ExaContentsProvider().process_content('doc-1'),
			).rejects.toMatchObject({
				type: 'PROVIDER_ERROR',
				details: { retryable: false },
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);

	it('counts only real extractions and preserves per-ID failures', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							id: 'doc-1',
							url: 'https://example.com/1',
							highlights: ['Real highlight'],
						},
						{
							id: 'doc-2',
							url: 'https://example.com/2',
							text: 'Do not use failed content',
						},
					],
					statuses: [
						{
							id: 'doc-1',
							status: 'success',
							source: 'cached',
							error: null,
						},
						{
							id: 'doc-2',
							status: 'error',
							error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: null },
						},
					],
				}),
			),
		);
		const result = await new ExaContentsProvider().process_content([
			'doc-1',
			'doc-2',
		]);
		expect(result.raw_contents).toEqual([
			{ url: 'https://example.com/1', content: 'Real highlight' },
		]);
		expect(result.metadata).toMatchObject({
			urls_processed: 2,
			successful_extractions: 1,
			failed_urls: ['doc-2'],
			word_count: 2,
		});
		expect(result.content).not.toContain('No content available');
		expect(result.content).not.toContain('Do not use failed content');
	});

	it('applies the configured abort timeout to contents requests', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-1',
					results: [
						{
							id: 'doc-1',
							title: 'Doc',
							url: 'https://example.com',
							text: 'content',
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await new ExaContentsProvider().process_content(
			'https://example.com',
		);
		expect(fetch_mock.mock.calls[0][1].signal).toBeInstanceOf(
			AbortSignal,
		);
	});

	it('accepts optional Exa response metadata being absent', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							id: 'doc-1',
							title: 'Doc',
							url: 'https://example.com',
							text: 'content',
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expect(
			new ExaContentsProvider().process_content('exa-result-id'),
		).resolves.toMatchObject({
			source_provider: 'exa_contents',
			metadata: { requestId: undefined },
		});
	});

	it('rejects private URLs and mixed URL/ID requests before fetching', async () => {
		const provider = new ExaContentsProvider();
		await expect(
			provider.process_content('http://127.0.0.1/private'),
		).rejects.toMatchObject({
			message: expect.stringContaining('Invalid URL'),
		});
		await expect(
			provider.process_content([
				'https://example.com',
				'exa-result-id',
			]),
		).rejects.toMatchObject({
			message:
				'Do not mix Exa result IDs and URLs in one contents request',
		});
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-1',
					results: { unexpected: true },
				}),
				{ status: 200 },
			),
		);

		await expect(
			new ExaContentsProvider().process_content('exa-result-id'),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'exa_contents',
			message: 'Malformed exa_contents response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
