import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { LinkupProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.ai_response.linkup.api_key;

describe('LinkupProvider response validation', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.ai_response.linkup.api_key = 'linkup-test-key';
	});

	afterEach(() => {
		config.ai_response.linkup.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('accepts a valid sourced answer with an empty source list', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ answer: 'Validated answer', sources: [] }),
				{ status: 200 },
			),
		);

		await expect(
			new LinkupProvider().search({ query: 'question' }),
		).resolves.toMatchObject([
			{ snippet: 'Validated answer', source_provider: 'linkup' },
		]);
	});

	it('rejects a malformed sources envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					answer: 'Answer',
					sources: { unexpected: true },
				}),
				{ status: 200 },
			),
		);

		await expect(
			new LinkupProvider().search({ query: 'malformed' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'linkup',
			message: 'Malformed linkup response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
