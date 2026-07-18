import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { TavilySearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.search.tavily.api_key;

describe('TavilySearchProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.search.tavily.api_key = 'tavily-test-key';
	});

	afterEach(() => {
		config.search.tavily.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('applies the configured abort timeout to search requests', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: [], response_time: '0.1' }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await new TavilySearchProvider().search({ query: 'test' });
		expect(fetch_mock.mock.calls[0][1].signal).toBeInstanceOf(
			AbortSignal,
		);
	});
});
