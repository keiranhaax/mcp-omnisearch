import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { BraveMediaSearchProvider } from './index.js';
const previous_key = config.search.brave_media.api_key;
const fetch_mock = vi.fn();
beforeEach(() => {
	config.search.brave_media.api_key = 'brave-test-key';
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
});
afterEach(() => {
	config.search.brave_media.api_key = previous_key;
	vi.unstubAllGlobals();
});
describe('Brave media response contract', () => {
	it.each(['images', 'videos'] as const)(
		'%s validates response bodies',
		async (type) => {
			for (const body of [
				{},
				{ error: 'upstream failure' },
				{ results: {} },
				{ results: [{}] },
				{ results: [{ title: 'Broken', url: '  ' }] },
			]) {
				fetch_mock.mockReset();
				fetch_mock.mockImplementation(
					async () => new Response(JSON.stringify(body)),
				);
				await expect(
					new BraveMediaSearchProvider().search({
						query: 'query',
						type,
					}),
				).rejects.toMatchObject({
					type: 'PROVIDER_ERROR',
					details: { retryable: false },
				});
				expect(fetch_mock).toHaveBeenCalledTimes(1);
			}
		},
	);
	it.each(['images', 'videos'] as const)(
		'%s accepts explicit zero results and maps real hits',
		async (type) => {
			fetch_mock.mockResolvedValueOnce(
				new Response(JSON.stringify({ results: [] })),
			);
			await expect(
				new BraveMediaSearchProvider().search({
					query: 'query',
					type,
				}),
			).resolves.toEqual([]);
			fetch_mock.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title: 'Result',
								url: 'https://example.com',
								description: 'Description',
								extra_snippets: ['Excerpt'],
								properties: { url: 'https://example.com/image.png' },
							},
						],
					}),
				),
			);
			const result = await new BraveMediaSearchProvider().search({
				query: 'query',
				type,
			});
			expect(result[0]).toMatchObject({
				title: 'Result',
				url: 'https://example.com',
				source_provider: 'brave_media_search',
			});
		},
	);
});
