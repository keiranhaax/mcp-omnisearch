import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { BraveNewsSearchProvider } from './search/brave_news/index.js';
import { BraveMediaSearchProvider } from './search/brave_media/index.js';
import { BraveLlmContextProvider } from './processing/brave_llm_context/index.js';
import { FirecrawlScrapeProvider } from './processing/firecrawl_scrape/index.js';
import { FirecrawlSearchProvider } from './processing/firecrawl_search/index.js';
import { YouSearchProvider } from './search/you/index.js';
import { config } from '../config/env.js';
const fetch_mock = vi.fn();
const previous_you_key = config.search.you.api_key;
beforeEach(() => {
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
	config.search.you.api_key = 'you-test-key';
});
afterEach(() => {
	vi.unstubAllGlobals();
	config.search.you.api_key = previous_you_key;
});
describe('provider numeric contracts', () => {
	it.each([NaN, Infinity, -1, 0, 1.5])(
		'rejects invalid positive result limits (%s) before HTTP',
		async (count) => {
			const calls = [
				() =>
					new BraveNewsSearchProvider().search({
						query: 'test',
						count,
					}),
				() =>
					new BraveMediaSearchProvider().search({
						query: 'test',
						type: 'images',
						count,
					}),
				() =>
					new BraveMediaSearchProvider().search({
						query: 'test',
						type: 'videos',
						count,
					}),
				() =>
					new BraveLlmContextProvider().get_context('test', {
						count,
					}),
				() =>
					new FirecrawlSearchProvider().process_content(
						'test',
						'basic',
						{ limit: count },
					),
				() =>
					new YouSearchProvider().search({
						query: 'test',
						limit: count,
					}),
			];
			for (const call of calls)
				await expect(call()).rejects.toMatchObject({
					type: 'INVALID_INPUT',
					message: expect.stringMatching(/integer|between/),
				});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it.each([NaN, Infinity, -1, 0.5, 10])(
		'rejects invalid Brave offsets (%s)',
		async (offset) => {
			await expect(
				new BraveNewsSearchProvider().search({
					query: 'test',
					offset,
				}),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				message: expect.stringContaining('offset'),
			});
			await expect(
				new BraveMediaSearchProvider().search({
					query: 'test',
					type: 'videos',
					offset,
				}),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				message: expect.stringContaining('offset'),
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it('rejects out-of-range result limits', async () => {
		for (const call of [
			() =>
				new BraveNewsSearchProvider().search({
					query: 'test',
					count: 51,
				}),
			() =>
				new BraveMediaSearchProvider().search({
					query: 'test',
					type: 'videos',
					count: 51,
				}),
			() =>
				new BraveMediaSearchProvider().search({
					query: 'test',
					type: 'images',
					count: 201,
				}),
			() =>
				new FirecrawlSearchProvider().process_content(
					'test',
					'basic',
					{ limit: 101 },
				),
		])
			await expect(call()).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				message: expect.stringContaining('integer'),
			});
		expect(fetch_mock).not.toHaveBeenCalled();
	});
	it.each([NaN, Infinity, -1, 0.5])(
		'rejects invalid scrape ages/waits (%s)',
		async (value) => {
			for (const field of ['maxAge', 'minAge', 'wait_for_ms']) {
				await expect(
					new FirecrawlScrapeProvider().process_content(
						'https://example.com',
						'basic',
						{ [field]: value },
					),
				).rejects.toMatchObject({
					type: 'INVALID_INPUT',
					message: expect.stringContaining(field),
				});
			}
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it.each([NaN, Infinity])(
		'rejects nonfinite location (%s)',
		async (value) => {
			for (const field of ['loc_lat', 'loc_long']) {
				await expect(
					new BraveLlmContextProvider().get_context('test', {
						[field]: value,
					}),
				).rejects.toMatchObject({
					type: 'INVALID_INPUT',
					message: expect.stringContaining(field),
				});
			}
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
});
