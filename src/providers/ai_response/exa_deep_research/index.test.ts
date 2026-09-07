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
import { ExaDeepResearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.ai_response.exa_deep_research.api_key;

describe('ExaDeepResearchProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.ai_response.exa_deep_research.api_key = 'exa-test-key';
	});

	afterEach(() => {
		config.ai_response.exa_deep_research.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('allowlists deep research controls while preserving structured synthesis and grounding', async () => {
		const content = {
			token: 'source-token',
			api_key: 'example',
			config: { api_key: 'source-example' },
		};
		const citation = {
			id: 'doc:1',
			url: 'https://example.com/docs?token=syntax&q=a%2Bb',
			text: 'const api_key = "example"; $x^2$ [1]',
		};
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'Bearer CONTROL_CANARY',
					output: {
						content,
						grounding: [
							{
								field: 'api_key',
								confidence: 0.9,
								citations: [
									{
										...citation,
										config: { api_key: 'CONTROL_CANARY' },
									},
								],
								headers: { authorization: 'CONTROL_CANARY' },
							},
						],
						config: { api_key: 'CONTROL_CANARY' },
					},
					costDollars: {
						total: 0.012,
						search: { neural: -1, headers: 'CONTROL_CANARY' },
						rawError: { message: 'CONTROL_CANARY' },
					},
					results: [citation],
				}),
			),
		);
		const results = await new ExaDeepResearchProvider().search({
			query: 'syntax',
		});
		expect(JSON.stringify(results)).not.toContain('CONTROL_CANARY');
		expect(results[0].snippet).toBe(JSON.stringify(content, null, 2));
		expect(results[0].metadata).toMatchObject({
			costDollars: { total: 0.012 },
			grounding: [
				{ field: 'api_key', confidence: 0.9, citations: [citation] },
			],
		});
		expect(results[0].metadata?.requestId).toBeUndefined();
		expect(get_response_metadata(results)).toEqual({
			usage: { usd: 0.012 },
		});
		expect(results[1]).toMatchObject({
			url: citation.url,
			snippet: citation.text,
			metadata: { id: 'doc:1' },
		});
	});

	it.each(['x'.repeat(129), { rawError: 'CONTROL_CANARY' }])(
		'discards malformed request IDs without rejecting synthesis: %j',
		async (requestId) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						requestId,
						output: { content: 'Source synthesis' },
					}),
				),
			);
			const [result] = await new ExaDeepResearchProvider().search({
				query: 'test',
			});
			expect(result.metadata?.requestId).toBeUndefined();
			expect(result.snippet).toBe('Source synthesis');
		},
	);

	it('attaches safe response metadata only to the root array', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-usage',
					costDollars: { total: 0.012 },
					output: { content: 'source' },
					results: [{ id: 'doc-1', url: 'https://example.com' }],
				}),
			),
		);
		const results = await new ExaDeepResearchProvider().search({
			query: 'usage',
		});
		expect(get_response_metadata(results)).toEqual({
			request_id: 'req-usage',
			usage: { usd: 0.012 },
		});
		for (const result of results)
			expect(get_response_metadata(result)).toBeUndefined();
	});

	it.each([
		{},
		{ output: null },
		{ output: {} },
		{ output: { content: null } },
		{ output: { content: '  ' } },
		{ output: { content: 'Answer' }, results: [{}] },
	])(
		'rejects missing synthesis or malformed sources once: %o',
		async (body) => {
			fetch_mock.mockImplementation(
				async () => new Response(JSON.stringify(body)),
			);
			await expect(
				new ExaDeepResearchProvider().search({ query: 'test' }),
			).rejects.toMatchObject({
				type: 'PROVIDER_ERROR',
				details: { retryable: false },
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);

	it('accepts nullable Exa source metadata', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					output: { content: 'Answer' },
					results: [
						{
							url: 'https://example.com',
							title: null,
							text: null,
							summary: null,
							author: null,
							publishedDate: null,
							score: null,
						},
					],
					costDollars: { total: 0.1 },
				}),
			),
		);
		const results = await new ExaDeepResearchProvider().search({
			query: 'test',
		});
		expect(results[0].snippet).toBe('Answer');
		expect(results[1].url).toBe('https://example.com');
	});

	it('calls Exa search with deep-reasoning and default text output schema', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-1',
					output: {
						content: 'Synthesized answer',
						grounding: [{ field: 'answer', citations: [] }],
					},
					results: [
						{
							id: 'doc-1',
							title: 'Source One',
							url: 'https://example.com/source',
							text: 'Source text',
							score: 0.8,
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new ExaDeepResearchProvider();
		const results = await provider.search({
			query: '  compare current AI search APIs  ',
			limit: 3,
		});

		const [, options] = fetch_mock.mock.calls[0];
		const body = JSON.parse(options.body);

		expect(fetch_mock.mock.calls[0][0]).toBe(
			'https://api.exa.ai/search',
		);
		expect(body).toMatchObject({
			query: 'compare current AI search APIs',
			type: 'deep-reasoning',
			numResults: 3,
			outputSchema: { type: 'text' },
		});
		expect(results[0]).toMatchObject({
			title: 'Exa Deep Research',
			snippet: 'Synthesized answer',
			source_provider: 'exa_deep_research',
			metadata: {
				requestId: 'req-1',
				type: 'deep_research',
				results_count: 1,
			},
		});
		expect(results[1]).toMatchObject({
			title: 'Source One',
			url: 'https://example.com/source',
			snippet: 'Source text',
			source_provider: 'exa_deep_research',
		});
	});

	it('passes structured output_schema through to Exa', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-2',
					output: {
						content: { answer: 'yes' },
						grounding: [],
					},
					results: [],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const output_schema = {
			type: 'object',
			properties: {
				answer: { type: 'string' },
			},
			required: ['answer'],
		};

		const provider = new ExaDeepResearchProvider();
		const results = await provider.search({
			query: 'return structured output',
			output_schema,
		});

		const [, options] = fetch_mock.mock.calls[0];
		const body = JSON.parse(options.body);

		expect(body.outputSchema).toEqual(output_schema);
		expect(results[0].snippet).toBe(
			JSON.stringify({ answer: 'yes' }, null, 2),
		);
	});

	it('allows deep mode and system prompt overrides', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-3',
					output: { content: 'Deep answer', grounding: [] },
					results: [],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new ExaDeepResearchProvider();
		await provider.search({
			query: 'deep search',
			search_type: 'deep',
			system_prompt: 'Use terse bullets.',
		});

		const [, options] = fetch_mock.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(body).toMatchObject({
			type: 'deep',
			systemPrompt: 'Use terse bullets.',
		});
	});
});
