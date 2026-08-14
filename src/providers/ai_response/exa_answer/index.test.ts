import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { ExaAnswerProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.ai_response.exa_answer.api_key;

describe('ExaAnswerProvider response validation', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.ai_response.exa_answer.api_key = 'exa-test-key';
	});

	afterEach(() => {
		config.ai_response.exa_answer.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('accepts a valid answer with optional citations omitted', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					answer: 'Validated answer',
					requestId: 'req-1',
				}),
				{ status: 200 },
			),
		);

		await expect(
			new ExaAnswerProvider().search({ query: 'question' }),
		).resolves.toMatchObject([
			{ snippet: 'Validated answer', source_provider: 'exa_answer' },
		]);
	});

	it('rejects a malformed answer envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					answer: { unexpected: true },
					requestId: 'req-1',
				}),
				{ status: 200 },
			),
		);

		await expect(
			new ExaAnswerProvider().search({ query: 'malformed' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'exa_answer',
			message: 'Malformed exa_answer response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
