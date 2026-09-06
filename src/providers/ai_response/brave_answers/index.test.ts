import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { BraveAnswersProvider } from './index.js';

const previous_key = config.ai_response.brave_answers.api_key;
const fetch_mock = vi.fn();
beforeEach(() => {
	config.ai_response.brave_answers.api_key = 'brave-test-key';
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
});
afterEach(() => {
	config.ai_response.brave_answers.api_key = previous_key;
	vi.unstubAllGlobals();
});
describe('Brave Answers response contract', () => {
	it.each([
		{},
		{ error: 'upstream failure' },
		{ choices: [] },
		{ choices: [{}] },
		{ choices: [{ message: { content: null } }] },
		{ choices: [{ message: { content: '   ' } }] },
	])('rejects unusable success bodies once: %o', async (body) => {
		fetch_mock.mockImplementation(
			async () => new Response(JSON.stringify(body)),
		);
		await expect(
			new BraveAnswersProvider().search({ query: 'question' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			details: { retryable: false },
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
	it('returns a real nonstreaming answer and usage', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: 'assistant',
								content: 'Grounded answer',
							},
						},
					],
					model: 'brave',
					usage: { total_tokens: 10 },
				}),
			),
		);
		const result = await new BraveAnswersProvider().search({
			query: 'question',
		});
		expect(result[0]).toMatchObject({
			snippet: 'Grounded answer',
			metadata: { usage: { total_tokens: 10 } },
		});
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({ stream: false });
	});
});
