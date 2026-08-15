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

	it('normalizes date and country operators for Tavily API fields', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: [], response_time: '0.1' }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await new TavilySearchProvider().search({
			query:
				'example after:2024-05 before:2024-05-10 loc:United-Kingdom',
		});

		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({
			start_date: '2024-05-01',
			end_date: '2024-05-10',
			country: 'united kingdom',
		});
	});

	it.each(['1.67', 1.67])(
		'accepts response_time as %o',
		async (response_time) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						results: [
							{
								title: 'Result',
								url: 'https://example.com',
								content: 'Snippet',
								score: 0.5,
							},
						],
						response_time,
					}),
					{ status: 200 },
				),
			);

			await expect(
				new TavilySearchProvider().search({ query: 'timing' }),
			).resolves.toHaveLength(1);
		},
	);

	it('accepts an omitted results array as an empty current response', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ response_time: '0.1' }), {
				status: 200,
			}),
		);

		await expect(
			new TavilySearchProvider().search({ query: 'no results' }),
		).resolves.toEqual([]);
	});

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: { unexpected: true } }),
				{ status: 200 },
			),
		);

		await expect(
			new TavilySearchProvider().search({ query: 'malformed' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'tavily',
			message: 'Malformed tavily response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
