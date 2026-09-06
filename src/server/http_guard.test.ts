import {
	createServer,
	request as http_request,
	type IncomingHttpHeaders,
	type Server,
} from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	check_host,
	check_origin,
	classify_body,
	create_guard_server,
	default_guard_config,
	modern_protocol_version_key,
	parse_guard_integer,
} from './http_guard.js';

const allowed = ['127.0.0.1:8000', 'mcp.keiranh.cloud'];

describe('guard resource settings', () => {
	it('parses byte limits independently of port ranges', () => {
		expect(parse_guard_integer('4194304', 1024, 'body bytes')).toBe(
			4194304,
		);
		expect(parse_guard_integer(undefined, 1024, 'body bytes')).toBe(
			1024,
		);
		for (const raw of [
			'0',
			'-1',
			'Infinity',
			'1.5',
			'9007199254740992',
			'1e3',
		]) {
			expect(() =>
				parse_guard_integer(raw, 1024, 'body bytes'),
			).toThrow();
		}
	});
	it('bounds raw connections even before headers arrive', () => {
		const server = create_guard_server(
			default_guard_config({
				allowed_hosts: ['test'],
				max_connections: 7,
			}),
		);
		expect(server.maxConnections).toBe(7);
	});
});

describe('check_host', () => {
	it('accepts exact allowlist entries with and without port', () => {
		expect(check_host('127.0.0.1:8000', allowed)).toEqual({
			ok: true,
			host: '127.0.0.1:8000',
		});
		expect(check_host('mcp.keiranh.cloud', allowed)).toEqual({
			ok: true,
			host: 'mcp.keiranh.cloud',
		});
	});

	it('normalizes case before matching', () => {
		expect(check_host('MCP.KEIRANH.CLOUD', allowed).ok).toBe(true);
	});

	it('rejects a missing Host header', () => {
		expect(check_host(undefined, allowed)).toEqual({
			ok: false,
			reason: 'missing',
		});
	});

	it('rejects unknown hosts', () => {
		expect(check_host('evil.example.com', allowed)).toEqual({
			ok: false,
			reason: 'not_allowed',
		});
	});

	it('rejects userinfo instead of crashing (#2489)', () => {
		expect(check_host('user:pass@127.0.0.1:8000', allowed)).toEqual({
			ok: false,
			reason: 'userinfo',
		});
	});

	it('rejects malformed hosts', () => {
		expect(check_host('bad host', allowed).ok).toBe(false);
		expect(check_host('http://x/y', allowed).ok).toBe(false);
		expect(check_host('', allowed).ok).toBe(false);
	});
});

describe('check_origin', () => {
	it('allows absent Origin (non-browser clients)', () => {
		expect(check_origin(undefined, allowed)).toEqual({ ok: true });
	});

	it('allows allowlisted origins', () => {
		expect(
			check_origin('https://mcp.keiranh.cloud', allowed),
		).toEqual({ ok: true });
	});

	it('rejects disallowed origins', () => {
		expect(check_origin('https://evil.example.com', allowed)).toEqual(
			{ ok: false, reason: 'not_allowed' },
		);
	});

	it('rejects userinfo and non-http schemes', () => {
		expect(
			check_origin('https://user:pass@mcp.keiranh.cloud', allowed).ok,
		).toBe(false);
		expect(check_origin('file:///etc/passwd', allowed)).toEqual({
			ok: false,
			reason: 'scheme',
		});
	});

	it('rejects unparseable origins such as "null"', () => {
		expect(check_origin('null', allowed).ok).toBe(false);
	});
});

describe('classify_body', () => {
	it('detects a modern envelope and echoes the id', () => {
		const body = Buffer.from(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 'abc',
				method: 'tools/list',
				params: {
					_meta: {
						[modern_protocol_version_key]: '2026-07-28',
					},
				},
			}),
		);
		expect(classify_body(body)).toEqual({
			modern_envelope: true,
			id: 'abc',
		});
	});

	it('treats legacy requests without _meta as legacy', () => {
		const body = Buffer.from(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 7,
				method: 'initialize',
				params: { protocolVersion: '2025-11-25' },
			}),
		);
		expect(classify_body(body)).toEqual({
			modern_envelope: false,
			id: 7,
		});
	});

	it('detects batches while leaving parse errors to the proxy', () => {
		expect(classify_body(Buffer.from('not json'))).toEqual({
			modern_envelope: false,
			id: null,
		});
		expect(classify_body(Buffer.from('[{"jsonrpc":"2.0"}]'))).toEqual(
			{ modern_envelope: false, id: null, batch: true },
		);
	});
});

interface GuardResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

const send = (options: {
	port: number;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
	chunked?: boolean;
}): Promise<GuardResponse> =>
	new Promise((resolve, reject) => {
		const req = http_request(
			{
				host: '127.0.0.1',
				port: options.port,
				method: options.method ?? 'POST',
				path: options.path ?? '/mcp',
				headers: {
					'x-api-key': 'guard-test-key',
					...options.headers,
				},
			},
			(res) => {
				let body = '';
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body,
					}),
				);
			},
		);
		req.on('error', reject);
		const body = options.body ?? '';
		if (!options.chunked && body.length > 0) {
			req.setHeader('content-length', Buffer.byteLength(body));
		}
		if (options.chunked) {
			req.write(body.slice(0, 10));
			req.end(body.slice(10));
		} else {
			req.end(body);
		}
	});

const raw_request = (port: number, bytes: string): Promise<string> =>
	new Promise((resolve, reject) => {
		let data = '';
		const socket = connect(port, '127.0.0.1', () =>
			socket.write(bytes),
		);
		socket.on('data', (chunk) => (data += chunk));
		socket.on('close', () => resolve(data));
		socket.on('error', reject);
		setTimeout(() => {
			socket.destroy();
			resolve(data);
		}, 2000);
	});

const get_free_port = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const probe = createServer();
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => resolve(port));
		});
		probe.on('error', reject);
	});

const close_server = (server: Server): Promise<void> =>
	new Promise((resolve) => server.close(() => resolve()));

describe('guard server integration', () => {
	let upstream: Server;
	let guard: Server;
	let guard_port: number;
	let upstream_hits = 0;

	beforeAll(async () => {
		upstream = createServer((req, res) => {
			upstream_hits++;
			if (req.url === '/ping') {
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.end('pong');
				return;
			}
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				res.writeHead(200, {
					'content-type': 'application/json',
				});
				res.end(JSON.stringify({ echoed: true, body }));
			});
		});
		await new Promise<void>((resolve) =>
			upstream.listen(0, '127.0.0.1', resolve),
		);
		const upstream_port = (upstream.address() as AddressInfo).port;

		guard_port = await get_free_port();
		guard = create_guard_server(
			default_guard_config({
				upstream_host: '127.0.0.1',
				upstream_port,
				allowed_hosts: [`127.0.0.1:${guard_port}`],
				api_key: 'guard-test-key',
				max_body_bytes: 1024,
				body_read_timeout_ms: 500,
			}),
		);
		await new Promise<void>((resolve) =>
			guard.listen(guard_port, '127.0.0.1', resolve),
		);
	});

	afterAll(async () => {
		await close_server(guard);
		await close_server(upstream);
	});

	it('rate-limits requests without retaining per-client state', async () => {
		const limited = create_guard_server(
			default_guard_config({
				allowed_hosts: ['limit.test'],
				api_key: 'guard-test-key',
				rate_limit_requests: 1,
				rate_limit_window_ms: 100,
				upstream_port: (upstream.address() as AddressInfo).port,
			}),
		);
		await new Promise<void>((resolve) =>
			limited.listen(0, '127.0.0.1', resolve),
		);
		const port = (limited.address() as AddressInfo).port;
		const options = {
			port,
			headers: { host: 'limit.test' },
			body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
		};
		try {
			expect((await send(options)).status).toBe(200);
			const throttled = await send(options);
			expect(throttled.status).toBe(429);
			expect(throttled.headers['retry-after']).toBe('1');
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect((await send(options)).status).toBe(200);
		} finally {
			limited.closeAllConnections();
			await close_server(limited);
		}
	});

	it('bounds concurrent uploads and releases the slot on abort', async () => {
		const limited = create_guard_server(
			default_guard_config({
				allowed_hosts: ['limit.test'],
				api_key: 'guard-test-key',
				max_inflight_requests: 1,
				body_read_timeout_ms: 500,
				upstream_port: (upstream.address() as AddressInfo).port,
			}),
		);
		await new Promise<void>((resolve) =>
			limited.listen(0, '127.0.0.1', resolve),
		);
		const port = (limited.address() as AddressInfo).port;
		const slow = connect(port, '127.0.0.1');
		try {
			await new Promise<void>((resolve) =>
				slow.once('connect', () => {
					slow.write(
						'POST /mcp HTTP/1.1\r\nhost: limit.test\r\nx-api-key: guard-test-key\r\ncontent-length: 100\r\n\r\nx',
						() => resolve(),
					);
				}),
			);
			const busy = await send({
				port,
				headers: { host: 'limit.test' },
				body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
			});
			expect(busy.status).toBe(429);
			slow.destroy();
			await new Promise((resolve) => setTimeout(resolve, 20));
			const next = await send({
				port,
				headers: { host: 'limit.test' },
				body: '{"jsonrpc":"2.0","id":2,"method":"ping"}',
			});
			expect(next.status).toBe(200);
		} finally {
			slow.destroy();
			limited.closeAllConnections();
			await close_server(limited);
		}
	});

	it('forwards a legacy request with an allowed Host', async () => {
		const res = await send({
			port: guard_port,
			body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).echoed).toBe(true);
	});

	it('rejects an unknown Host with 403', async () => {
		const hits_before = upstream_hits;
		const res = await send({
			port: guard_port,
			headers: { host: 'evil.example.com' },
			body: '{}',
		});
		expect(res.status).toBe(403);
		expect(upstream_hits).toBe(hits_before);
	});

	it('rejects a userinfo Host with 403, not 500', async () => {
		const res = await send({
			port: guard_port,
			headers: { host: `user:pass@127.0.0.1:${guard_port}` },
			body: '{}',
		});
		expect(res.status).toBe(403);
	});

	it('rejects a missing Host before routing', async () => {
		// llhttp itself refuses HTTP/1.1 requests without a Host
		// header; the guard answers 400 via clientError and closes.
		const raw = await raw_request(
			guard_port,
			'POST /mcp HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}',
		);
		expect(raw).toMatch(/HTTP\/1\.1 (400|403) /);
	});

	it('rejects a disallowed Origin without CORS headers', async () => {
		const res = await send({
			port: guard_port,
			headers: { origin: 'https://evil.example.com' },
			body: '{}',
		});
		expect(res.status).toBe(403);
		expect(
			res.headers['access-control-allow-origin'],
		).toBeUndefined();
	});

	it('forwards an allowlisted Origin', async () => {
		const res = await send({
			port: guard_port,
			headers: { origin: `http://127.0.0.1:${guard_port}` },
			body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
		});
		expect(res.status).toBe(200);
	});

	it('answers a CORS preflight without wildcard headers', async () => {
		const res = await send({
			port: guard_port,
			method: 'OPTIONS',
			headers: { origin: 'https://evil.example.com' },
		});
		expect([403, 405]).toContain(res.status);
		expect(
			res.headers['access-control-allow-origin'],
		).toBeUndefined();
	});

	it('limits routes to /mcp and /ping', async () => {
		const not_found = await send({ port: guard_port, path: '/sse' });
		expect(not_found.status).toBe(404);

		const wrong_method = await send({
			port: guard_port,
			method: 'GET',
		});
		expect(wrong_method.status).toBe(405);

		const ping = await send({
			port: guard_port,
			method: 'GET',
			path: '/ping',
		});
		expect(ping.status).toBe(200);
		expect(ping.body).toBe('pong');

		const ping_post = await send({ port: guard_port, path: '/ping' });
		expect(ping_post.status).toBe(405);
	});

	it.each(['[]', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]'])(
		'rejects JSON-RPC batches before forwarding: %s',
		async (body) => {
			const hits_before = upstream_hits;
			const res = await send({ port: guard_port, body });
			expect(res.status).toBe(400);
			expect(JSON.parse(res.body).error.code).toBe(-32600);
			expect(upstream_hits).toBe(hits_before);
		},
	);

	it('rejects declared oversize bodies with 413', async () => {
		const hits_before = upstream_hits;
		const res = await send({
			port: guard_port,
			body: 'x'.repeat(2048),
		});
		expect(res.status).toBe(413);
		expect(upstream_hits).toBe(hits_before);
	});

	it('rejects chunked oversize bodies with 413', async () => {
		const res = await send({
			port: guard_port,
			body: 'x'.repeat(2048),
			chunked: true,
		});
		expect(res.status).toBe(413);
	});

	it('rejects a modern envelope without the version header (#2589)', async () => {
		const hits_before = upstream_hits;
		const res = await send({
			port: guard_port,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'modern-1',
				method: 'tools/list',
				params: {
					_meta: {
						[modern_protocol_version_key]: '2026-07-28',
					},
				},
			}),
		});
		expect(res.status).toBe(400);
		const parsed = JSON.parse(res.body);
		expect(parsed.error.code).toBe(-32020);
		expect(parsed.id).toBe('modern-1');
		expect(upstream_hits).toBe(hits_before);
	});

	it('forwards a modern envelope with the version header', async () => {
		const res = await send({
			port: guard_port,
			headers: {
				'content-type': 'application/json',
				'mcp-protocol-version': '2026-07-28',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'modern-2',
				method: 'tools/list',
				params: {
					_meta: {
						[modern_protocol_version_key]: '2026-07-28',
					},
				},
			}),
		});
		expect(res.status).toBe(200);
	});

	it.each([
		'content-length: 1000000000',
		'transfer-encoding: chunked',
	])(
		'rejects a ping upload without waiting for its body: %s',
		async (header) => {
			const hits_before = upstream_hits;
			const raw = await raw_request(
				guard_port,
				`GET /ping HTTP/1.1\r\nhost: 127.0.0.1:${guard_port}\r\n${header}\r\n\r\n`,
			);
			expect(raw).toContain('HTTP/1.1 400');
			expect(upstream_hits).toBe(hits_before);
		},
	);

	it.each(['', 'x-api-key: wrong\r\n'])(
		'rejects unauthenticated uploads before reading body: %s',
		async (auth) => {
			const hits_before = upstream_hits;
			const raw = await raw_request(
				guard_port,
				`POST /mcp HTTP/1.1\r\nhost: 127.0.0.1:${guard_port}\r\n${auth}content-length: 100\r\n\r\n`,
			);
			expect(raw).toContain('HTTP/1.1 401');
			expect(upstream_hits).toBe(hits_before);
		},
	);

	it('flushes an honest 408 before closing a slow upload', async () => {
		const raw = await raw_request(
			guard_port,
			`POST /mcp HTTP/1.1\r\nhost: 127.0.0.1:${guard_port}\r\nx-api-key: guard-test-key\r\ncontent-length: 100\r\n\r\nx`,
		);
		expect(raw).toContain('HTTP/1.1 408');
		expect(raw).toContain('Request Timeout');
	});

	it('survives a client aborting mid-body', async () => {
		await new Promise<void>((resolve) => {
			const socket = connect(guard_port, '127.0.0.1', () => {
				socket.write(
					'POST /mcp HTTP/1.1\r\n' +
						`host: 127.0.0.1:${guard_port}\r\n` +
						'content-length: 100\r\n\r\n' +
						'{"partial"',
					() => socket.destroy(),
				);
			});
			socket.on('error', () => resolve());
			socket.on('close', () => resolve());
		});
		const res = await send({
			port: guard_port,
			body: '{"jsonrpc":"2.0","id":3,"method":"tools/list"}',
		});
		expect(res.status).toBe(200);
	});

	it('returns 502 when the upstream is down', async () => {
		const closed_port = await get_free_port();
		const lonely_port = await get_free_port();
		const lonely = create_guard_server(
			default_guard_config({
				upstream_host: '127.0.0.1',
				upstream_port: closed_port,
				allowed_hosts: [`127.0.0.1:${lonely_port}`],
				api_key: 'guard-test-key',
				max_body_bytes: 1024,
			}),
		);
		await new Promise<void>((resolve) =>
			lonely.listen(lonely_port, '127.0.0.1', resolve),
		);
		try {
			const res = await send({
				port: lonely_port,
				body: '{"jsonrpc":"2.0","id":4,"method":"tools/list"}',
			});
			expect(res.status).toBe(502);
		} finally {
			await close_server(lonely);
		}
	});
});
