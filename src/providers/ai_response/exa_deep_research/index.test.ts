import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
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
