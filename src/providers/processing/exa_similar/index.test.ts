import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { ExaSimilarProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.exa_similar.api_key;

describe('ExaSimilarProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.exa_similar.api_key = 'exa-test-key';
	});

	afterEach(() => {
		config.processing.exa_similar.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('applies the configured abort timeout to similar-page requests', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ requestId: 'req-1', results: [] }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await new ExaSimilarProvider().process_content(
			'https://example.com',
		);
		expect(fetch_mock.mock.calls[0][1].signal).toBeInstanceOf(
			AbortSignal,
		);
	});
});
