import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { BraveNewsSearchProvider } from './index.js';
const previous_key = config.search.brave_news.api_key;
const fetch_mock = vi.fn();
beforeEach(() => {
	config.search.brave_news.api_key = 'brave-test-key';
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
});
afterEach(() => {
	config.search.brave_news.api_key = previous_key;
	vi.unstubAllGlobals();
});
describe('Brave news response contract', () => {
	it('validates response bodies', async () => {
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
				new BraveNewsSearchProvider().search({ query: 'query' }),
			).rejects.toMatchObject({
				type: 'PROVIDER_ERROR',
				details: { retryable: false },
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		}
	});
	it('accepts explicit zero results and maps real hits', async () => {
		fetch_mock.mockResolvedValueOnce(
			new Response(JSON.stringify({ results: [] })),
		);
		await expect(
			new BraveNewsSearchProvider().search({ query: 'query' }),
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
		const result = await new BraveNewsSearchProvider().search({
			query: 'query',
		});
		expect(result[0]).toMatchObject({
			title: 'Result',
			url: 'https://example.com',
			source_provider: 'brave_news_search',
		});
	});
});
