import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { BraveLlmContextProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.brave_llm_context.api_key;

describe('BraveLlmContextProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.brave_llm_context.api_key = 'brave-test-key';
	});

	afterEach(() => {
		config.processing.brave_llm_context.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('clamps numeric options to Brave LLM Context API bounds', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					grounding: {
						generic: [
							{
								title: 'Result',
								url: 'https://example.com',
								snippets: ['Snippet'],
							},
						],
					},
					sources: {},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new BraveLlmContextProvider();
		await provider.get_context('best docs', {
			count: 3.5,
			maximum_number_of_urls: 0,
			maximum_number_of_tokens: 1000,
			maximum_number_of_snippets: 0,
			maximum_number_of_tokens_per_url: 500,
			maximum_number_of_snippets_per_url: 0,
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			count: 3,
			maximum_number_of_urls: 1,
			maximum_number_of_tokens: 1024,
			maximum_number_of_snippets: 1,
			maximum_number_of_tokens_per_url: 512,
			maximum_number_of_snippets_per_url: 1,
		});
	});

	it('passes enable_local and goggles in the request body', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					grounding: {
						generic: [
							{
								title: 'Result',
								url: 'https://example.com',
								snippets: ['Snippet'],
							},
						],
					},
					sources: {},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new BraveLlmContextProvider();
		const result = await provider.get_context('best docs', {
			enable_local: true,
			goggles: 'https://example.com/goggle.txt',
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			q: 'best docs',
			enable_local: true,
			goggles: 'https://example.com/goggle.txt',
		});
		expect(result.content).toContain('Snippet');
	});

	it('maps location inputs to X-Loc headers', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					grounding: {
						generic: [
							{
								title: 'Result',
								url: 'https://example.com',
								snippets: ['Snippet'],
							},
						],
					},
					sources: {},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new BraveLlmContextProvider();
		await provider.get_context('coffee near me', {
			loc_lat: 37.7749,
			loc_long: -122.4194,
			loc_city: 'San Francisco',
			loc_state: 'CA',
			loc_state_name: 'California',
			loc_country: 'US',
			loc_postal_code: '94103',
		});

		const headers = fetch_mock.mock.calls[0][1].headers;
		expect(headers).toMatchObject({
			'X-Loc-Lat': '37.7749',
			'X-Loc-Long': '-122.4194',
			'X-Loc-City': 'San Francisco',
			'X-Loc-State': 'CA',
			'X-Loc-State-Name': 'California',
			'X-Loc-Country': 'US',
			'X-Loc-Postal-Code': '94103',
		});
	});

	it('rejects invalid latitude and longitude before calling Brave', async () => {
		const provider = new BraveLlmContextProvider();
		await expect(
			provider.get_context('query', { loc_lat: 91 }),
		).rejects.toThrow('loc_lat must be between -90 and 90');
		await expect(
			provider.get_context('query', { loc_long: -181 }),
		).rejects.toThrow('loc_long must be between -180 and 180');
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});
