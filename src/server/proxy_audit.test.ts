import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const require_proxy = createRequire(import.meta.resolve('mcp-proxy'));
const proxy_root = process.env.MCP_PROXY_AUDIT_ROOT
	? resolve(process.env.MCP_PROXY_AUDIT_ROOT)
	: dirname(dirname(require_proxy.resolve('mcp-proxy')));
const proxy_cli = join(proxy_root, 'dist/bin/mcp-proxy.mjs');

// Exercise the published CLI's private filter without running its main().
const filter_section = readFileSync(proxy_cli, 'utf8')
	.split('//#region src/JSONFilterTransform.ts')[1]
	?.split('//#endregion')[0];
if (!filter_section) throw new Error('Missing published JSON filter');
const Filter = runInNewContext(
	`(() => { ${filter_section}; return JSONFilterTransform; })()`,
	{ Transform, StringDecoder, Buffer, console },
) as new () => Transform;

const filter = async (chunks: Buffer[]) => {
	const output: Buffer[] = [];
	await pipeline(
		Readable.from(chunks),
		new Filter(),
		new Writable({
			write(chunk: Buffer, _encoding, callback) {
				output.push(chunk);
				callback();
			},
		}),
	);
	return Buffer.concat(output).toString();
};

const free_port = async () => {
	const probe = createServer();
	await new Promise<void>((resolve) =>
		probe.listen(0, '127.0.0.1', resolve),
	);
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
};

const start_cli = async (subscribe = true) => {
	const port = await free_port();
	// Resolve scratch bundle dependencies through the untouched installed proxy.
	const preload = `
import {registerHooks} from 'node:module';
const root = ${JSON.stringify(pathToFileURL(proxy_root + '/').href)};
registerHooks({resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(root) && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
    return nextResolve(specifier, {...context, parentURL: ${JSON.stringify(import.meta.resolve('mcp-proxy'))}});
  }
  return nextResolve(specifier, context);
}});`;
	const fixture = `
import {createInterface} from 'node:readline';
let stalled = false;
createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = {
    protocolVersion: '2025-11-25',
    serverInfo: {name: 'offline-fixture', version: '1'},
    capabilities: {tools: {}, resources: {subscribe: ${subscribe}}}
  };
  if (message.method === 'ping' && stalled) return;
  if (message.method === 'resources/subscribe') {
    process.stderr.write('SUBSCRIBE\\n');
    if (message.params.uri === 'fixture://slow') {
      setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {}}) + '\\n'), 150);
      return;
    }
  }
  if (message.method === 'resources/unsubscribe') process.stderr.write('UNSUBSCRIBE\\n');
  if (message.method === 'tools/call') {
    result = {content: [{type: 'text', text: 'ok'}]};
    if (message.params.name === 'die') setTimeout(() => process.exit(0), 20);
    if (message.params.name === 'stall') stalled = true;
    if (message.params.name === 'overflow') {
      process.stdout.write('x'.repeat(10 * 1024 * 1024 + 1));
      return;
    }
  }
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\\n');
});`;
	const child = spawn(
		process.execPath,
		[
			'--import',
			`data:text/javascript,${encodeURIComponent(preload)}`,
			proxy_cli,
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--server',
			'stream',
			'--stateless',
			'--no-eventStore',
			'--gracefulShutdownTimeout',
			'1000',
			'--',
			process.execPath,
			'--input-type=module',
			'-e',
			fixture,
		],
		{
			env: { PATH: process.env.PATH },
			stdio: 'pipe',
			detached: true,
		},
	);
	let stderr = '';
	child.stderr.on('data', (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-16384);
	});
	child.stdout.resume();
	const exited = once(child, 'exit');
	const base = `http://127.0.0.1:${port}`;
	const close = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill('SIGTERM');
		const timer = setTimeout(() => {
			if (child.pid) process.kill(-child.pid, 'SIGKILL');
		}, 2000);
		try {
			await exited;
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		await expect
			.poll(
				async () => {
					if (child.exitCode !== null) throw new Error(stderr);
					return fetch(`${base}/ping`, {
						signal: AbortSignal.timeout(200),
					})
						.then((response) => response.status)
						.catch(() => 0);
				},
				{ timeout: 3000 },
			)
			.toBe(200);
	} catch (error) {
		await close();
		throw error;
	}
	const send = (
		method: string,
		params = {},
		modern = false,
		signal?: AbortSignal,
	) =>
		fetch(`${base}/mcp`, {
			method: 'POST',
			signal,
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'mcp-method': method,
				'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method,
				params: {
					...params,
					...(modern
						? {
								_meta: {
									'io.modelcontextprotocol/protocolVersion':
										'2026-07-28',
									'io.modelcontextprotocol/clientInfo': {
										name: 'audit',
										version: '1',
									},
									'io.modelcontextprotocol/clientCapabilities': {},
								},
							}
						: {}),
				},
			}),
		});
	return { child, close, send, base, stderr: () => stderr };
};

describe('published proxy CLI upstream lifecycle', () => {
	it('exits nonzero when the initialized upstream exits cleanly', async () => {
		const fixture = await start_cli();
		try {
			await (
				await fixture.send('tools/call', { name: 'die' })
			).text();
			await expect
				.poll(() => fixture.child.exitCode, { timeout: 2000 })
				.toBe(1);
		} finally {
			await fixture.close();
		}
	});

	it('exits nonzero on upstream framing overflow', async () => {
		const fixture = await start_cli();
		try {
			const pending = fixture
				.send('tools/call', { name: 'overflow' })
				.then((response) => response.text())
				.catch(() => undefined);
			await expect
				.poll(() => fixture.child.exitCode, { timeout: 2500 })
				.toBe(1);
			await pending;
		} finally {
			await fixture.close();
		}
	});

	it('reports ready only when the upstream answers a bounded ping', async () => {
		const fixture = await start_cli();
		try {
			const ready = await fetch(`${fixture.base}/ready`);
			expect(ready.status).toBe(200);
			expect(await ready.json()).toEqual({ status: 'ready' });
			await (
				await fixture.send('tools/call', { name: 'stall' })
			).text();
			const started = Date.now();
			const unavailable = await fetch(`${fixture.base}/ready`, {
				signal: AbortSignal.timeout(2000),
			});
			expect(unavailable.status).toBe(503);
			expect(await unavailable.json()).toEqual({
				status: 'unavailable',
			});
			expect(Date.now() - started).toBeLessThan(1800);
			expect((await fetch(`${fixture.base}/ping`)).status).toBe(200);
		} finally {
			await fixture.close();
		}
	});

	it('keeps intentional shutdown successful', async () => {
		const fixture = await start_cli();
		await fixture.close();
		expect(fixture.child.exitCode).toBe(0);
	});
});

describe('published proxy modern subscription admission', () => {
	it('releases a subscription accepted upstream after downstream disconnect', async () => {
		const fixture = await start_cli();
		const controller = new AbortController();
		try {
			const pending = fixture
				.send(
					'subscriptions/listen',
					{
						notifications: {
							resourceSubscriptions: ['fixture://slow'],
						},
					},
					true,
					controller.signal,
				)
				.catch(() => undefined);
			await expect.poll(fixture.stderr).toContain('SUBSCRIBE');
			controller.abort();
			await pending;
			await expect.poll(fixture.stderr).toContain('UNSUBSCRIBE');
		} finally {
			controller.abort();
			await fixture.close();
		}
	});
	it('does not acquire URIs from an HTTP-200 invalid-filter error', async () => {
		const fixture = await start_cli();
		try {
			const response = await fixture.send(
				'subscriptions/listen',
				{
					notifications: {
						resourceSubscriptions: ['fixture://valid', 3],
					},
				},
				true,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				error: { code: -32602 },
			});
			expect(fixture.stderr()).not.toContain('SUBSCRIBE');
		} finally {
			await fixture.close();
		}
	});

	it('does not acquire resource subscriptions the server cannot honor', async () => {
		const fixture = await start_cli(false);
		const controller = new AbortController();
		try {
			const response = await fixture.send(
				'subscriptions/listen',
				{
					notifications: {
						resourceSubscriptions: ['fixture://valid'],
					},
				},
				true,
				controller.signal,
			);
			expect(response.status).toBe(200);
			const first = await response.body!.getReader().read();
			expect(Buffer.from(first.value!).toString()).toContain(
				'"notifications":{}',
			);
			expect(fixture.stderr()).not.toContain('SUBSCRIBE');
		} finally {
			controller.abort();
			await fixture.close();
		}
	});

	it('acquires accepted subscriptions and releases on disconnect', async () => {
		const fixture = await start_cli();
		const controller = new AbortController();
		try {
			const response = await fixture.send(
				'subscriptions/listen',
				{
					notifications: {
						resourceSubscriptions: ['fixture://valid'],
					},
				},
				true,
				controller.signal,
			);
			expect(response.headers.get('content-type')).toContain(
				'text/event-stream',
			);
			const first = await response.body!.getReader().read();
			expect(Buffer.from(first.value!).toString()).toContain(
				'fixture://valid',
			);
			expect(fixture.stderr()).toContain('SUBSCRIBE');
			controller.abort();
			await expect.poll(fixture.stderr).toContain('UNSUBSCRIBE');
		} finally {
			controller.abort();
			await fixture.close();
		}
	});
});

describe('published proxy stdout framing', () => {
	it('allows the exact byte limit and resets it for each complete line', async () => {
		const frame = Buffer.from(
			'{' + ' '.repeat(10 * 1024 * 1024 - 2) + '}\n',
		);
		expect(await filter([Buffer.concat([frame, frame])])).toBe(
			frame.toString().repeat(2),
		);
	});

	it('counts multibyte input and decoder-retained bytes toward the limit', async () => {
		const frame = Buffer.from('é'.repeat(5 * 1024 * 1024) + 'é');
		await expect(
			filter([
				frame.subarray(0, frame.length - 1),
				frame.subarray(frame.length - 1),
			]),
		).rejects.toThrow(/line.*exceeds.*bytes/i);
	});
	it('rejects oversized unterminated and completed lines', async () => {
		const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
		for (const ending of ['', '\n']) {
			await expect(
				filter([
					oversized.subarray(0, 100),
					oversized.subarray(100),
					Buffer.from(ending),
				]),
			).rejects.toThrow(/line.*exceeds.*bytes/i);
		}
	});

	it('delimits the last frame when stdout ends without a newline', async () => {
		expect(await filter([Buffer.from('{"text":"🧭"}')])).toBe(
			'{"text":"🧭"}\n',
		);
	});

	it('preserves UTF-8 split at every byte boundary', async () => {
		const frame = Buffer.from('{"text":"café 中文 🧭"}\n');
		for (let split = 1; split < frame.length; split++) {
			expect(
				await filter([
					frame.subarray(0, split),
					frame.subarray(split),
				]),
			).toBe(frame.toString());
		}
	});
});
