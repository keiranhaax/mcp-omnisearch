import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { ExaSearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.search.exa.api_key;

describe('ExaSearchProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.search.exa.api_key = 'exa-test-key';
	});

	afterEach(() => {
		config.search.exa.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('uses auto search and text contents by default', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-1',
					results: [
						{
							id: 'doc-1',
							title: 'Doc',
							url: 'https://example.com',
							text: 'Text content',
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new ExaSearchProvider();
		const results = await provider.search({
			query: '  latest docs  ',
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toEqual({
			query: 'latest docs',
			type: 'auto',
			numResults: 10,
			contents: { text: { maxCharacters: 3000 } },
		});
		expect(results[0]).toMatchObject({
			title: 'Doc',
			url: 'https://example.com',
			snippet: 'Text content',
			metadata: { requestId: 'req-1' },
		});
	});

	it('maps modern Exa fields into the search request', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const output_schema = {
			type: 'object',
			properties: { answer: { type: 'string' } },
		};

		const provider = new ExaSearchProvider();
		await provider.search({
			query: 'company research',
			limit: 5,
			include_domains: ['example.com'],
			search_type: 'deep-reasoning',
			category: 'company',
			user_location: 'US',
			contents: { summary: true },
			additional_queries: ['funding', 'headquarters'],
			output_schema,
			system_prompt: 'Return concise data.',
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toEqual({
			query: 'company research',
			type: 'deep-reasoning',
			numResults: 5,
			includeDomains: ['example.com'],
			contents: { summary: true },
			additionalQueries: ['funding', 'headquarters'],
			category: 'company',
			userLocation: 'US',
			outputSchema: output_schema,
			systemPrompt: 'Return concise data.',
		});
	});

	it('does not require resolvedSearchType or score in responses', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title: 'No score',
							url: 'https://example.com/no-score',
							summary: 'Summary only',
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new ExaSearchProvider();
		const [result] = await provider.search({
			query: 'missing fields',
		});

		expect(result.score).toBeUndefined();
		expect(result.metadata?.resolvedSearchType).toBeUndefined();
		expect(result.snippet).toBe('Summary only');
	});

	it('maps the current searchType field without requiring its retired predecessor', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					searchType: 'auto',
					results: [
						{
							title: 'Current response',
							url: 'https://example.com/current',
							text: 'Current content',
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const [result] = await new ExaSearchProvider().search({
			query: 'current field',
		});

		expect(result.metadata?.resolvedSearchType).toBe('auto');
	});

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: { unexpected: true } }),
				{ status: 200 },
			),
		);

		await expect(
			new ExaSearchProvider().search({ query: 'malformed' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'exa',
			message: 'Malformed exa response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
