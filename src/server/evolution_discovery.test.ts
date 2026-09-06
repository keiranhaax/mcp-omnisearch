import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import type { GenericSchema } from 'valibot';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { store_result } from '../common/result_store.js';
// Synthetic configuration only. Fresh modules model a cold process, not a
// credential hot reload. No live entitlement or tenant isolation is implied.
let create_server: typeof import('./create_server.js').create_server;
let register_tools: typeof import('./tools/index.js').register_tools;
let configurations: Array<{
	name: string;
	settings: { api_key: string | undefined };
}>;
const all_tool_names = [
	'ai_search',
	'brave_llm_context',
	'brave_media_search',
	'brave_news_search',
	'context_brand_intel',
	'context_classify',
	'context_styleguide',
	'context_transaction_identify',
	'context_web_extract',
	'firecrawl_agent',
	'github_search',
	'result_read',
	'web_extract',
	'web_search',
];
let home: string;
const fetch_mock = vi.fn(() => {
	throw new Error('P0_UNEXPECTED_PROVIDER_NETWORK');
});
const configure = (enabled: (name: string) => boolean) => {
	for (const { name, settings } of configurations)
		settings.api_key = enabled(name)
			? 'p0-offline-fixture-key'
			: undefined;
};
const make_server = () =>
	create_server({ name: 'p0-offline-fixture', version: '1' });
const p1a_additions = JSON.parse(
	readFileSync(
		new URL(
			'./fixtures/evolution-p1a/schema-additions.json',
			import.meta.url,
		),
		'utf8',
	),
) as Record<string, Record<string, unknown>>;
const snapshot = (name: string) =>
	JSON.parse(
		readFileSync(
			new URL(
				`./fixtures/evolution-discovery/${name}.json`,
				import.meta.url,
			),
			'utf8',
		),
	);
// Preserve the captured P0 schemas byte-for-byte; permit only reviewed
// optional P1A additions, checking their exact client-visible definitions.
const expect_p0_compatibility = (
	tools: Awaited<ReturnType<typeof discover>>,
	profile: string,
) => {
	const legacy = structuredClone(tools);
	for (const tool of legacy) {
		const properties = tool.inputSchema.properties as Record<
			string,
			unknown
		>;
		for (const [field, schema] of Object.entries(
			p1a_additions[tool.name] ?? {},
		)) {
			expect(properties[field]).toEqual(schema);
			expect(tool.inputSchema.required).not.toContain(field);
			delete properties[field];
		}
	}
	expect(legacy).toEqual(snapshot(profile));
};
const discover = async () => {
	const response: any = await make_server().receive({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/list',
		params: {},
	});
	expect(response.error).toBeUndefined();
	return response.result.tools as Array<{
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
	}>;
};

beforeEach(async () => {
	vi.resetModules();
	const { config } = await import('../config/env.js');
	({ create_server } = await import('./create_server.js'));
	({ register_tools } = await import('./tools/index.js'));
	configurations = Object.values(config).flatMap((category) =>
		Object.entries(category).map(([name, settings]) => ({
			name,
			settings,
		})),
	);
	home = mkdtempSync(join(tmpdir(), 'omnisearch-p0-discovery-'));
	vi.stubEnv('OMNISEARCH_RESULT_DIR', join(home, 'results'));
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockClear();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	configure(() => true);
});
afterEach(() => {
	const calls = fetch_mock.mock.calls.length;
	configure(() => false);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
	expect(calls).toBe(0);
});

describe('P0 configured discovery contract', () => {
	it('snapshots all client-visible schemas and verifies conversion from registration', async () => {
		const tools = await discover();
		expect(tools.map(({ name }) => name).sort()).toEqual(
			all_tool_names,
		);
		const definitions: Array<{
			name: string;
			schema: GenericSchema;
		}> = [];
		register_tools({
			tool: (definition: { name: string; schema: GenericSchema }) => {
				definitions.push(definition);
			},
		} as any);
		expect(definitions).toHaveLength(tools.length);
		const adapter = new ValibotJsonSchemaAdapter();
		for (const definition of definitions) {
			const converted = await adapter.toJsonSchema(definition.schema);
			expect(
				tools.find(({ name }) => name === definition.name)
					?.inputSchema,
			).toEqual(converted);
		}
		expect_p0_compatibility(tools, 'all-providers');
	});

	it('retains only result_read without any configured provider', async () => {
		configure(() => false);
		const tools = await discover();
		expect(tools.map(({ name }) => name)).toEqual(['result_read']);
		expect_p0_compatibility(tools, 'no-providers');
	});

	it('removes only github_search when the GitHub key is missing', async () => {
		configure((name) => name !== 'github');
		const tools = await discover();
		expect(tools.map(({ name }) => name).sort()).toEqual(
			all_tool_names.filter((name) => name !== 'github_search'),
		);
		expect_p0_compatibility(tools, 'no-github');
	});

	it('advertises the Tavily-only provider enums without unrelated tools', async () => {
		configure((name) => name.startsWith('tavily'));
		const tools = await discover();
		expect(tools.map(({ name }) => name).sort()).toEqual([
			'ai_search',
			'result_read',
			'web_extract',
			'web_search',
		]);
		expect_p0_compatibility(tools, 'tavily-only');
	});

	it('adds P1A chunks while compact mode and a local extractor remain absent', async () => {
		const tools = await discover();
		for (const name of ['web_search', 'web_extract']) {
			const schema = tools.find(
				(tool) => tool.name === name,
			)!.inputSchema;
			expect(schema.properties).not.toHaveProperty('response_mode');
		}
		const extract = tools.find(({ name }) => name === 'web_extract')!;
		expect(extract.inputSchema.properties).toHaveProperty('query');
		expect(extract.inputSchema.properties).toHaveProperty(
			'chunks_per_source',
		);
		expect(JSON.stringify(extract.inputSchema)).not.toContain(
			'defuddle',
		);
	});

	it('records stale singleton registration after in-process key removal', async () => {
		await discover();
		configure(() => false);
		const tools = await discover();
		// Baseline gap, not desired hot-reload behavior. These initializers
		// do not clear their existing provider when configuration disappears.
		expect(tools.map(({ name }) => name).sort()).toEqual([
			'brave_llm_context',
			'brave_media_search',
			'brave_news_search',
			'firecrawl_agent',
			'github_search',
			'result_read',
		]);
	});
});

describe('P0 result privacy boundary, not tenant isolation', () => {
	const read = async (
		server: ReturnType<typeof make_server>,
		id: string,
	) => {
		const response: any = await server.receive({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: { name: 'result_read', arguments: { result_id: id } },
		});
		return response.result;
	};

	it('uses private filesystem permissions but shares a handle across server instances', async () => {
		configure(() => false);
		const first = make_server();
		const stored = store_result(
			'P0 private fixture, not user content',
		);
		expect(statSync(join(home, 'results')).mode & 0o777).toBe(0o700);
		expect(
			statSync(join(home, 'results', `${stored.result_id}.txt`))
				.mode & 0o777,
		).toBe(0o600);
		const first_result = await read(first, stored.result_id);
		const second_result = await read(make_server(), stored.result_id);
		expect(second_result).toEqual(first_result);
		expect(JSON.parse(second_result.content[0].text).content).toBe(
			'P0 private fixture, not user content',
		);
	});

	it('cannot read the handle from a separate configured result directory', async () => {
		configure(() => false);
		const stored = store_result('P0 directory A');
		vi.stubEnv('OMNISEARCH_RESULT_DIR', join(home, 'other-results'));
		const response = await read(make_server(), stored.result_id);
		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain(
			'Result not found or expired',
		);
		expect(response.content[0].text).not.toContain('P0 directory A');
	});
});
