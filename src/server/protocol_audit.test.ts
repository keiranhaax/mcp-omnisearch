import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';

const make_server = () =>
	new McpServer<v.GenericSchema>(
		{ name: 'protocol-audit', version: '1' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: {}, resources: {}, prompts: {} },
		},
	);

const invoke = (
	server: ReturnType<typeof make_server>,
	method: string,
	params: Record<string, unknown>,
) => server.receive({ jsonrpc: '2.0', id: 1, method, params });

describe('tmcp protocol errors', () => {
	it('returns invalid params for unknown tools without echoing names', async () => {
		const response = await invoke(make_server(), 'tools/call', {
			name: 'unknown-private-name',
		});
		expect(response).toMatchObject({
			id: 1,
			error: { code: -32602 },
		});
		expect(JSON.stringify(response)).not.toContain(
			'unknown-private-name',
		);
	});

	it('preserves explicit MCP invalid-params errors in JSON-RPC', async () => {
		const response = await invoke(make_server(), 'initialize', {
			protocolVersion: 'not-a-version',
			capabilities: {},
			clientInfo: { name: 'fixture', version: '1' },
		});
		expect(response).toMatchObject({
			id: 1,
			error: { code: -32602 },
		});
	});

	it('returns invalid params for missing resource URIs', async () => {
		const response = await invoke(make_server(), 'resources/read', {
			uri: 'private://unknown-secret',
		});
		expect(response).toMatchObject({
			id: 1,
			error: { code: -32602 },
		});
		expect(JSON.stringify(response)).not.toContain('unknown-secret');
	});

	it('does not reflect malformed initialization values', async () => {
		const response = await invoke(make_server(), 'initialize', {
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: {
				name: 'fixture',
				version: { secret: 'private-init' },
			},
		});
		expect(response).toMatchObject({ error: { code: -32602 } });
		expect(JSON.stringify(response)).not.toContain('private-init');
	});
});

// Exercise the installed package, not a copy of its validation logic.
describe('tmcp validation privacy', () => {
	it('redacts dynamic record keys and custom validator messages', async () => {
		const server = make_server();
		server.tool(
			{
				name: 'record',
				description: 'Offline fixture',
				schema: v.object({
					values: v.record(
						v.string(),
						v.number('custom-private-message'),
					),
				}),
			},
			() => ({ content: [] }),
		);
		const response = await invoke(server, 'tools/call', {
			name: 'record',
			arguments: {
				values: { 'private-record-key': 'private-record-value' },
			},
		});
		const wire = JSON.stringify(response);
		expect(response).toMatchObject({ result: { isError: true } });
		expect(wire.includes('private')).toBe(false);
		expect(wire).toContain('values');
	});

	it('redacts invalid structured output diagnostics', async () => {
		const server = make_server();
		server.tool(
			{
				name: 'output',
				description: 'Offline fixture',
				outputSchema: v.object({ count: v.number() }),
			},
			() =>
				({
					content: [],
					structuredContent: { count: 'private-output' },
				}) as never,
		);
		const response = await invoke(server, 'tools/call', {
			name: 'output',
		});
		expect(response).toMatchObject({ result: { isError: true } });
		expect(JSON.stringify(response).includes('private-output')).toBe(
			false,
		);
	});

	it('redacts prompt issue values and preserves invalid-params codes', async () => {
		const server = make_server();
		server.prompt(
			{
				name: 'prompt',
				description: 'Offline fixture',
				schema: v.object({ count: v.number() }),
			},
			() => ({ messages: [] }),
		);
		const response = await invoke(server, 'prompts/get', {
			name: 'prompt',
			arguments: { count: 'private-prompt' },
		});
		expect(response).toMatchObject({ error: { code: -32602 } });
		expect(JSON.stringify(response).includes('private-prompt')).toBe(
			false,
		);
	});

	it('does not expose arbitrary thrown error messages or logs', async () => {
		const server = make_server();
		server.tool(
			{ name: 'throwing', description: 'Offline fixture' },
			() => {
				throw new Error('private-backend-error');
			},
		);
		const warnings = vi
			.spyOn(console, 'warn')
			.mockImplementation(() => {});
		try {
			const response = await invoke(server, 'tools/call', {
				name: 'throwing',
			});
			expect(response).toMatchObject({
				error: { code: -32603, message: 'Internal error' },
			});
			expect(warnings).not.toHaveBeenCalled();
		} finally {
			warnings.mockRestore();
		}
	});

	it('bounds nested issue diagnostics without reflecting argument values', async () => {
		const server = make_server();
		let executed = false;
		server.tool(
			{
				name: 'validated',
				description: 'Offline schema fixture',
				schema: v.object({
					query: v.pipe(v.string(), v.maxLength(4)),
					items: v.array(v.object({ count: v.number() })),
				}),
			},
			() => {
				executed = true;
				return { content: [] };
			},
		);
		const secret = 'fixture-secret-never-reflect';
		const response = await invoke(server, 'tools/call', {
			name: 'validated',
			arguments: {
				query: secret,
				items: Array.from({ length: 100 }, () => ({
					count: secret.repeat(100),
				})),
			},
		});
		const wire = JSON.stringify(response);
		expect(response).toMatchObject({ result: { isError: true } });
		expect(executed).toBe(false);
		expect(wire.includes(secret)).toBe(false);
		expect(wire.includes('\\"input\\"')).toBe(false);
		expect(wire.includes('\\"received\\"')).toBe(false);
		expect(wire).toContain('query');
		expect(wire).toContain('max_length');
		expect(Buffer.byteLength(wire)).toBeLessThan(4096);
	});
});
