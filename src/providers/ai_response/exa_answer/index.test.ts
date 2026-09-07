import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { get_response_metadata } from '../../../common/response_metadata.js';
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

	it.each([
		'Bearer CONTROL_CANARY',
		'x'.repeat(129),
		{ config: 'CONTROL_CANARY' },
	])(
		'validates request metadata without altering answer or citations: %j',
		async (requestId) => {
			const url =
				'https://example.com/docs?token=syntax&q=a%2Bb#math';
			const answer =
				'~~~js\nconst api_key = "example";\n~~~ $x^2$ [1]';
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						requestId,
						answer,
						costDollars: { total: { config: 'CONTROL_CANARY' } },
						citations: [
							{
								id: 'doc:1',
								url,
								text: 'token syntax',
								headers: { authorization: 'CONTROL_CANARY' },
							},
						],
					}),
				),
			);
			const results = await new ExaAnswerProvider().search({
				query: 'syntax',
			});
			expect(results[0].metadata?.requestId).toBeUndefined();
			expect(get_response_metadata(results)).toBeUndefined();
			expect(JSON.stringify(results)).not.toContain('CONTROL_CANARY');
			expect(results[0].snippet).toBe(answer);
			expect(results[1]).toMatchObject({
				url,
				snippet: 'token syntax',
				metadata: { id: 'doc:1' },
			});
		},
	);

	it('attaches safe response metadata only to the root array', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-usage',
					costDollars: { total: 0.005 },
					answer: 'source',
					citations: [{ id: 'doc-1', url: 'https://example.com' }],
				}),
			),
		);
		const results = await new ExaAnswerProvider().search({
			query: 'usage',
		});
		expect(get_response_metadata(results)).toEqual({
			request_id: 'req-usage',
			usage: { usd: 0.005 },
		});
		for (const result of results)
			expect(get_response_metadata(result)).toBeUndefined();
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

	it('tolerates citations missing id and title', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					answer: 'Answer',
					requestId: 'req-2',
					citations: [{ url: 'https://example.com/citation' }],
				}),
				{ status: 200 },
			),
		);

		const results = await new ExaAnswerProvider().search({
			query: 'question',
		});

		expect(results[1]).toMatchObject({
			title: 'https://example.com/citation',
			url: 'https://example.com/citation',
			snippet: 'Source reference',
			source_provider: 'exa_answer',
		});
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
