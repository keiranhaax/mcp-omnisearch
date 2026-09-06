import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../config/env.js';
import { ExaSimilarProvider } from './exa_similar/index.js';
import { FirecrawlActionsProvider } from './firecrawl_actions/index.js';
import { FirecrawlCrawlProvider } from './firecrawl_crawl/index.js';
import { FirecrawlExtractProvider } from './firecrawl_extract/index.js';
import { FirecrawlMapProvider } from './firecrawl_map/index.js';

const previous_key = config.processing.exa_similar.api_key;
const fetch_mock = vi.fn();
beforeEach(() => {
	config.processing.exa_similar.api_key = 'exa-test-key';
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
});
afterEach(() => {
	config.processing.exa_similar.api_key = previous_key;
	vi.unstubAllGlobals();
});
describe('single-target processing contracts', () => {
	it.each([
		ExaSimilarProvider,
		FirecrawlActionsProvider,
		FirecrawlCrawlProvider,
		FirecrawlExtractProvider,
		FirecrawlMapProvider,
	])(
		'rejects multiple targets before any fetch ($name)',
		async (Provider) => {
			await expect(
				new Provider().process_content([
					'https://example.com/one',
					'https://example.com/two',
				]),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				message: expect.stringContaining('exactly one'),
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
});
