import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import {
	get_available_providers,
	initialize_web_search,
} from '../../../server/tools/web_search.js';
import { SearxngSearchProvider, searxng_base_url } from './index.js';

const fetch_mock = vi.fn();
const previous = {
	searxng: config.search.searxng.base_url,
	tavily: config.search.tavily.api_key,
	brave: config.search.brave.api_key,
	exa: config.search.exa.api_key,
	you: config.search.you.api_key,
};
const body = (results: unknown[]) =>
	Response.json({
		query: 'needle',
		number_of_results: results.length,
		results,
		suggestions: ['needle thread'],
	});
const item = (url: string, extra: Record<string, unknown> = {}) => ({
	url,
	title: `Title ${url}`,
	content: `snippet for ${url}`,
	engine: 'duckduckgo',
	engines: ['duckduckgo', 'brave'],
	score: 2.5,
	category: 'general',
	...extra,
});

beforeEach(() => {
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	config.search.searxng.base_url = 'http://searx.test:8080/';
});

afterEach(() => {
	config.search.searxng.base_url = previous.searxng;
	config.search.tavily.api_key = previous.tavily;
	config.search.brave.api_key = previous.brave;
	config.search.exa.api_key = previous.exa;
	config.search.you.api_key = previous.you;
	initialize_web_search();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('SearXNG configuration', () => {
	it.each([
		[undefined, undefined],
		['', undefined],
		['   ', undefined],
		['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
		[
			'https://search.internal/searx/',
			'https://search.internal/searx',
		],
		['http://searx.test:8080/', 'http://searx.test:8080'],
		['searx.test', undefined],
		['ftp://searx.test', undefined],
		['http://user:pw@searx.test', undefined],
		['http://searx.test/?x=1', undefined],
		['http://searx.test/#x', undefined],
	])(
		'reads SEARXNG_URL %j as %j without echoing it',
		(raw, expected) => {
			config.search.searxng.base_url = raw;
			expect(searxng_base_url()).toBe(expected);
			for (const call of vi.mocked(console.warn).mock.calls)
				expect(String(call[0])).not.toContain('searx');
		},
	);

	it('registers the provider only when the URL is set, beside keyed providers', () => {
		config.search.tavily.api_key = 'searxng-fixture-key';
		config.search.brave.api_key = undefined;
		config.search.exa.api_key = undefined;
		config.search.you.api_key = undefined;
		expect(initialize_web_search()).toBe(true);
		expect(get_available_providers()).toEqual(['tavily', 'searxng']);
		config.search.searxng.base_url = undefined;
		initialize_web_search();
		expect(get_available_providers()).toEqual(['tavily']);
		config.search.tavily.api_key = undefined;
		config.search.searxng.base_url = 'http://searx.test:8080';
		expect(initialize_web_search()).toBe(true);
		expect(get_available_providers()).toEqual(['searxng']);
	});

	it('refuses to search when the configuration is missing', async () => {
		config.search.searxng.base_url = undefined;
		await expect(
			new SearxngSearchProvider().search({ query: 'needle' }),
		).rejects.toMatchObject({
			type: 'INVALID_INPUT',
			message: 'SearXNG is not configured',
		});
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});

describe('SearXNG search', () => {
	it('requests the JSON format from the configured instance and maps results', async () => {
		fetch_mock.mockResolvedValue(
			body([
				item('https://docs.test/a', { publishedDate: '2026-01-02' }),
				item('https://docs.test/b', {
					title: '  ',
					content: null,
					engines: undefined,
				}),
				{ url: 'not a url', title: 'skip' },
			]),
		);
		const results = await new SearxngSearchProvider().search({
			query: '  needle\nthread  ',
		});
		const [url, init] = fetch_mock.mock.calls[0];
		expect(String(url)).toBe(
			'http://searx.test:8080/search?q=needle+thread&format=json&pageno=1',
		);
		expect(init.method).toBe('GET');
		expect(init.headers).toEqual({ Accept: 'application/json' });
		expect(results).toEqual([
			{
				title: 'Title https://docs.test/a',
				url: 'https://docs.test/a',
				snippet: 'snippet for https://docs.test/a',
				score: 2.5,
				source_provider: 'searxng',
				metadata: {
					engines: ['duckduckgo', 'brave'],
					category: 'general',
					published_date: '2026-01-02',
				},
			},
			{
				title: 'https://docs.test/b',
				url: 'https://docs.test/b',
				snippet: '',
				score: 2.5,
				source_provider: 'searxng',
				metadata: { engines: ['duckduckgo'], category: 'general' },
			},
		]);
	});

	it('applies limit and domain filters locally', async () => {
		// A fresh Response per call: a body can only be read once.
		fetch_mock.mockImplementation(async () =>
			body([
				item('https://a.test/1'),
				item('https://sub.b.test/2'),
				item('https://b.test/3'),
				item('https://c.test/4'),
				item('https://a.test/5'),
			]),
		);
		const provider = new SearxngSearchProvider();
		expect(
			(await provider.search({ query: 'needle', limit: 2 })).map(
				(result) => result.url,
			),
		).toEqual(['https://a.test/1', 'https://sub.b.test/2']);
		expect(
			(
				await provider.search({
					query: 'needle',
					include_domains: ['B.test'],
				})
			).map((result) => result.url),
		).toEqual(['https://sub.b.test/2', 'https://b.test/3']);
		expect(
			(
				await provider.search({
					query: 'needle',
					exclude_domains: ['a.test', 'b.test'],
				})
			).map((result) => result.url),
		).toEqual(['https://c.test/4']);
		expect(
			await provider.search({
				query: 'needle',
				include_domains: ['z.test'],
			}),
		).toEqual([]);
	});

	it('explains a disabled JSON format instead of the generic entitlement text', async () => {
		fetch_mock.mockResolvedValue(
			new Response('Forbidden', { status: 403 }),
		);
		await expect(
			new SearxngSearchProvider().search({ query: 'needle' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			message:
				'SearXNG refused JSON output; enable the json format in its search settings',
			details: { status: 403, retryable: false, public: true },
		});
	});

	it('keeps other failures typed as usual', async () => {
		fetch_mock.mockResolvedValue(
			new Response('oops', { status: 500 }),
		);
		await expect(
			new SearxngSearchProvider().search({ query: 'needle' }),
		).rejects.toMatchObject({ details: { status: 500 } });
		fetch_mock.mockResolvedValue(new Response('{"results": "x"}'));
		await expect(
			new SearxngSearchProvider().search({ query: 'needle' }),
		).rejects.toMatchObject({ type: 'PROVIDER_ERROR' });
	});
});
