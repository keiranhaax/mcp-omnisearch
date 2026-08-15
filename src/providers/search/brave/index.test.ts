import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { BraveSearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.search.brave.api_key;

const json_response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});

describe('BraveSearchProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.search.brave.api_key = 'brave-test-key';
	});

	afterEach(() => {
		config.search.brave.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('returns no results when a valid response omits the web block', async () => {
		fetch_mock.mockResolvedValue(json_response({ type: 'search' }));

		await expect(
			new BraveSearchProvider().search({ query: 'no results' }),
		).resolves.toEqual([]);
	});

	it('skips non-result rows and tolerates an omitted description', async () => {
		fetch_mock.mockResolvedValue(
			json_response({
				web: {
					results: [
						{
							title: 'Complete result',
							url: 'https://example.com/complete',
							description: 'Complete snippet',
						},
						{ type: 'search', subtype: 'infobox' },
						{
							title: 'No description',
							url: 'https://example.com/no-description',
						},
						{
							url: 'https://example.com/no-title',
							description: 'Untitled snippet',
						},
					],
				},
			}),
		);

		await expect(
			new BraveSearchProvider().search({ query: 'mixed rows' }),
		).resolves.toEqual([
			{
				title: 'Complete result',
				url: 'https://example.com/complete',
				snippet: 'Complete snippet',
				source_provider: 'brave',
			},
			{
				title: 'No description',
				url: 'https://example.com/no-description',
				snippet: '',
				source_provider: 'brave',
			},
			{
				title: 'https://example.com/no-title',
				url: 'https://example.com/no-title',
				snippet: 'Untitled snippet',
				source_provider: 'brave',
			},
		]);
	});

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			json_response({
				web: { results: { unexpected: true } },
			}),
		);

		await expect(
			new BraveSearchProvider().search({ query: 'malformed' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'brave',
			message: 'Malformed brave response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
