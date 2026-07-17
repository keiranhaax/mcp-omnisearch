import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../config/env.js';
import {
	initialize_context_dev,
	register_context_dev_tools,
} from './context_dev.js';

const fetch_mock = vi.fn();
const previous_key = config.search.context_dev.api_key;

const create_server = () => {
	const tools: Array<{ definition: { name: string }; handler: any }> = [];
	return {
		tools,
		server: {
			tool: (definition: { name: string }, handler: any) => {
				tools.push({ definition, handler });
			},
		},
	};
};

describe('Context.dev tools', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.search.context_dev.api_key = 'ctx-test-key';
	});

	afterEach(() => {
		config.search.context_dev.api_key = previous_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('does not register tools when CONTEXT_DEV_API_KEY is missing', () => {
		config.search.context_dev.api_key = undefined;
		const { server, tools } = create_server();

		expect(initialize_context_dev()).toBe(false);
		register_context_dev_tools(server as any);

		expect(tools).toHaveLength(0);
	});

	it('registers the expected context tools when configured', () => {
		const { server, tools } = create_server();

		expect(initialize_context_dev()).toBe(true);
		register_context_dev_tools(server as any);

		expect(tools.map((tool) => tool.definition.name)).toEqual([
			'context_web_extract',
			'context_brand_intel',
			'context_styleguide',
			'context_classify',
			'context_transaction_identify',
		]);
	});

	it('maps markdown web extraction to the documented scrape endpoint', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ success: true, markdown: 'Hello', url: 'https://example.com' }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);

		const tool = tools.find((item) => item.definition.name === 'context_web_extract')!;
		const result = await tool.handler({
			mode: 'markdown',
			url: 'https://example.com',
			maxAgeMs: 0,
			timeoutMS: 1000,
		});

		const [url, options] = fetch_mock.mock.calls[0];
		expect(url).toBe(
			'https://api.context.dev/v1/web/scrape/markdown?url=https%3A%2F%2Fexample.com&timeoutMS=1000&maxAgeMs=0',
		);
		expect(options.headers.Authorization).toBe('Bearer ctx-test-key');
		expect(result.content[0].text).toContain('Hello');
	});

	it('maps brand lookup and transaction tools to documented brand endpoints', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ status: 'ok', brand: { title: 'Example' } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);

		await tools.find((item) => item.definition.name === 'context_brand_intel')!.handler({
			lookup_type: 'stock_ticker',
			value: 'AAPL',
		});
		expect(fetch_mock.mock.calls[0][0]).toBe(
			'https://api.context.dev/v1/brand/retrieve-by-ticker?ticker=AAPL',
		);

		await tools.find((item) => item.definition.name === 'context_transaction_identify')!.handler({
			transaction_info: 'SQ *COFFEE SHOP',
			country_gl: 'us',
		});
		expect(fetch_mock.mock.calls[1][0]).toBe(
			'https://api.context.dev/v1/brand/transaction_identifier?transaction_info=SQ+*COFFEE+SHOP&country_gl=us',
		);
	});

	it('uses brand retrieval for EIC classification data', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					status: 'ok',
					brand: { industries: { eic: [{ code: 'software' }] } },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);

		const result = await tools.find((item) => item.definition.name === 'context_classify')!.handler({
			taxonomy: 'eic',
			domain: 'example.com',
		});

		expect(fetch_mock.mock.calls[0][0]).toBe(
			'https://api.context.dev/v1/brand/retrieve?domain=example.com',
		);
		expect(result.content[0].text).toContain('software');
	});
});
