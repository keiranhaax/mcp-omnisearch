import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const fixture = `
import { McpServer } from 'tmcp';
import { StdioTransport } from '@tmcp/transport-stdio';
const server = new McpServer({name:'fixture', version:'1'}, {capabilities:{tools:{}}});
server.tool({name:'blocked', description:'Local test'}, async () => {
  const signal = server.ctx.signal;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      process.stderr.write('aborted\\n');
      resolve();
    }, {once:true});
  });
  return {content:[{type:'text',text:'done'}]};
});
new StdioTransport(server).listen();
process.stderr.write('ready\\n');
`;

const start_fixture = async () => {
	const child = spawn(
		process.execPath,
		['--input-type=module', '-e', fixture],
		{
			cwd: process.cwd(),
			stdio: ['pipe', 'pipe', 'pipe'],
		},
	);
	const responses: {
		id: number;
		result?: unknown;
		error?: { code: number };
	}[] = [];
	let pending = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (data: string) => {
		pending += data;
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';
		for (const line of lines) responses.push(JSON.parse(line));
	});
	child.stderr.on('data', (data: string) => {
		stderr += data;
	});
	await expect
		.poll(() => stderr, { timeout: 3000 })
		.toContain('ready');
	return {
		child,
		responses,
		stderr: () => stderr,
		close: async () => {
			if (child.exitCode === null) {
				child.kill('SIGTERM');
				await once(child, 'exit');
			}
		},
	};
};

const blocked = (id: number) => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: { name: 'blocked' },
});
const line = (message: unknown) => `${JSON.stringify(message)}\n`;

describe('installed stdio transport', () => {
	it('routes cancellation in the same chunk to the caller signal', async () => {
		const fixture = await start_fixture();
		try {
			fixture.child.stdin.write(
				line(blocked(1)) +
					line({
						jsonrpc: '2.0',
						method: 'notifications/cancelled',
						params: { requestId: 1 },
					}),
			);
			await expect
				.poll(() => fixture.stderr(), { timeout: 150 })
				.toContain('aborted');
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fixture.responses).toEqual([]);
		} finally {
			await fixture.close();
		}
	});

	it('dispatches a ping behind blocked work in the same chunk', async () => {
		const fixture = await start_fixture();
		try {
			fixture.child.stdin.write(
				line(blocked(1)) +
					line({ jsonrpc: '2.0', id: 2, method: 'ping' }),
			);
			await expect.poll(() => fixture.responses.length).toBe(2);
			expect(fixture.responses.map(({ id }) => id)).toEqual([2, 1]);
		} finally {
			await fixture.close();
		}
	});
});
