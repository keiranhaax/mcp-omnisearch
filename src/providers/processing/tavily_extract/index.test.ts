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
