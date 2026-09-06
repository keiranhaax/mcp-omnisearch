import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { TavilyExtractProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.tavily_extract.api_key;

describe('TavilyExtractProvider response validation', () => {
	it.each(['markdown', 'text'] as const)(
		'forwards explicit %s format without changing canonical mapping',
		async (format) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						results: [
							{
								url: 'https://example.test',
								raw_content: 'Evidence',
							},
						],
						failed_results: [],
					}),
				),
			);
			const result =
				await new TavilyExtractProvider().process_content(
					'https://example.test',
					'basic',
					{ format },
				);
			expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
				urls: ['https://example.test'],
				include_images: false,
				extract_depth: 'basic',
				format,
			});
			expect(result.content).toBe('Evidence');
			expect(result.raw_contents).toEqual([
				{ url: 'https://example.test', content: 'Evidence' },
			]);
		},
	);
	it.each(['html', null, 123])(
		'rejects unsupported direct format %o before networking',
		async (format) => {
			await expect(
				new TavilyExtractProvider().process_content(
					'https://example.test',
					'basic',
					{ format } as any,
				),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				details: { retryable: false },
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ chunks_per_source: 3 },
		{ query: 'test', chunks_per_source: 0 },
		{ query: 'test', chunks_per_source: 6 },
		{ query: 'test', chunks_per_source: 1.5 },
		{ query: ' ', chunks_per_source: 2 },
	])(
		'rejects invalid reranking options before requesting: %o',
		async (options) => {
			await expect(
				new TavilyExtractProvider().process_content(
					'https://example.com',
					'basic',
					options,
				),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				provider: 'tavily_extract',
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it('forwards query reranking and chunk count without changing extraction depth', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							url: 'https://example.com',
							raw_content: 'Relevant chunks',
						},
					],
					failed_results: [],
				}),
			),
		);
		await new TavilyExtractProvider().process_content(
			'https://example.com',
			'basic',
			{ query: 'mcp-omnisearch C++', chunks_per_source: 5 },
		);
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({
			query: 'mcp-omnisearch C++',
			chunks_per_source: 5,
			extract_depth: 'basic',
			include_images: false,
		});
	});
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.tavily_extract.api_key = 'tavily-test-key';
	});

	afterEach(() => {
		config.processing.tavily_extract.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('accepts a valid extract response', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ url: 'https://example.com', raw_content: 'Content' },
					],
					failed_results: [],
					response_time: 0.1,
				}),
				{ status: 200 },
			),
		);

		await expect(
			new TavilyExtractProvider().process_content(
				'https://example.com',
			),
		).resolves.toMatchObject({
			content: 'Content',
			source_provider: 'tavily_extract',
		});
	});

	it.each(['1.67', 1.67])(
		'accepts response_time as %o',
		async (response_time) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						results: [
							{ url: 'https://example.com', raw_content: 'Content' },
						],
						failed_results: [],
						response_time,
					}),
					{ status: 200 },
				),
			);

			await expect(
				new TavilyExtractProvider().process_content(
					'https://example.com',
				),
			).resolves.toMatchObject({
				content: 'Content',
				source_provider: 'tavily_extract',
			});
		},
	);

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: { unexpected: true },
					failed_results: [],
					response_time: 0.1,
				}),
				{ status: 200 },
			),
		);

		await expect(
			new TavilyExtractProvider().process_content(
				'https://example.com',
			),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'tavily_extract',
			message: 'Malformed tavily_extract response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
