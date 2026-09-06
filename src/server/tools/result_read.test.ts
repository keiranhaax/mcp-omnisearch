import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store_result } from '../../common/result_store.js';
import { register_result_read } from './result_read.js';

interface RegisteredTool {
	definition: {
		name: string;
		annotations?: Record<string, boolean>;
	};
	handler: (args: Record<string, unknown>) => Promise<any>;
}

let result_dir: string;

beforeEach(() => {
	result_dir = mkdtempSync(join(tmpdir(), 'result-read-tool-test-'));
	process.env.OMNISEARCH_RESULT_DIR = result_dir;
});

afterEach(() => {
	delete process.env.OMNISEARCH_RESULT_DIR;
	rmSync(result_dir, { recursive: true, force: true });
});

const create_mock_server = () => {
	const tools: RegisteredTool[] = [];
	return {
		tools,
		server: {
			tool: (
				definition: RegisteredTool['definition'],
				handler: RegisteredTool['handler'],
			) => tools.push({ definition, handler }),
		},
	};
};

describe('result_read tool', () => {
	it('registers as a local read-only tool and returns a requested chunk', async () => {
		const { server, tools } = create_mock_server();
		register_result_read(server as any);
		const tool = tools[0];
		const stored = store_result('first\nsecond\nthird');

		expect(tool.definition.name).toBe('result_read');
		expect(tool.definition.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const response = await tool.handler({
			result_id: stored.result_id,
			offset: 2,
			limit: 1,
		});
		const body = JSON.parse(response.content[0].text);
		expect(body.content).toBe('second');
		expect(body.next_offset).toBe(3);
	});

	it('forwards within-line continuation without oversized MCP text', async () => {
		const { server, tools } = create_mock_server();
		register_result_read(server as any);
		const text = '\u0000🙂'.repeat(10000);
		const stored = store_result(text);
		let offset = 1;
		let byte_offset = 0;
		let reconstructed = '';
		for (let page = 0; page < 20; page++) {
			const response = await tools[0].handler({
				result_id: stored.result_id,
				offset,
				byte_offset,
				limit: 1,
			});
			expect(
				Buffer.byteLength(JSON.stringify(response)),
			).toBeLessThan(100000);
			const chunk = JSON.parse(response.content[0].text);
			reconstructed += chunk.content;
			if (chunk.next_offset === undefined) break;
			offset = chunk.next_offset;
			byte_offset = chunk.next_byte_offset;
		}
		expect(reconstructed === text).toBe(true);
	});

	it('returns an MCP error for missing or expired IDs', async () => {
		const { server, tools } = create_mock_server();
		register_result_read(server as any);
		const response = await tools[0].handler({
			result_id: '123e4567-e89b-12d3-a456-426614174000',
		});

		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain(
			'Result not found or expired',
		);
	});
});
