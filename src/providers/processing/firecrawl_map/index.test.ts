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
import { FirecrawlMapProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.firecrawl_map.api_key;
const previous_base_url = config.processing.firecrawl_map.base_url;

const json_response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});

describe('FirecrawlMapProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_map.api_key = 'fc-test-key';
		config.processing.firecrawl_map.base_url =
			'https://api.firecrawl.dev/v2/map';
	});

	afterEach(() => {
		config.processing.firecrawl_map.api_key = previous_api_key;
		config.processing.firecrawl_map.base_url = previous_base_url;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('accepts links with optional titles', async () => {
		fetch_mock.mockResolvedValue(
			json_response({
				success: true,
				links: [
					{ url: 'https://site.test/a', title: 'A' },
					{ url: 'https://site.test/b' },
				],
			}),
		);

		const result = await new FirecrawlMapProvider().process_content(
			'https://site.test',
			'advanced',
		);

		expect(result).toMatchObject({
			content: expect.stringContaining('- https://site.test/a — A'),
			metadata: { word_count: 2, extract_depth: 'advanced' },
			source_provider: 'firecrawl_map',
		});
		expect(result.content).toContain('- https://site.test/b');
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed link collections as non-retryable', async () => {
		const sentinel = 'map-payload-secret-must-not-leak';
		fetch_mock.mockResolvedValue(
			json_response({ success: true, links: sentinel }),
		);

		let thrown: unknown;
		try {
			await new FirecrawlMapProvider().process_content(
				'https://site.test',
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl_map',
			message: 'Malformed firecrawl_map response',
			details: { retryable: false },
		});
		expect(JSON.stringify(thrown)).not.toContain(sentinel);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
