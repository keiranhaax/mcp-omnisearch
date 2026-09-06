#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	create_guard_server,
	default_guard_config,
	parse_guard_integer,
} from './server/http_guard.js';

/**
 * Production entrypoint for the Path A topology:
 *
 *   client -> http_guard (Tailscale IP) -> mcp-proxy (loopback)
 *          -> node dist/index.js (stdio)
 *
 * The guard owns the public socket and the strict edge checks; the
 * pinned proxy owns authentication and protocol translation. PM2 keeps
 * managing a single foreground process.
 */

const require_env = (name: string): string => {
	const value = process.env[name];
	if (!value) {
		console.error(`guard: missing required env ${name}`);
		process.exit(1);
	}
	return value;
};

const optional_port = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (!raw) return fallback;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`guard: ${name} must be an integer port`);
		process.exit(1);
	}
	return port;
};

const listen_host = require_env('GUARD_LISTEN_HOST');
const listen_port = optional_port('GUARD_LISTEN_PORT', NaN);
if (Number.isNaN(listen_port)) {
	console.error('guard: missing required env GUARD_LISTEN_PORT');
	process.exit(1);
}
const upstream_host = process.env.GUARD_UPSTREAM_HOST ?? '127.0.0.1';
const upstream_port = optional_port('GUARD_UPSTREAM_PORT', 8002);
const allowed_hosts = require_env('GUARD_ALLOWED_HOSTS')
	.split(',')
	.map((host) => host.trim().toLowerCase())
	.filter((host) => host.length > 0);
if (allowed_hosts.length === 0) {
	console.error(
		'guard: GUARD_ALLOWED_HOSTS must list at least one host',
	);
	process.exit(1);
}
const max_body_bytes = parse_guard_integer(
	process.env.GUARD_MAX_BODY_BYTES,
	4 * 1024 * 1024,
	'GUARD_MAX_BODY_BYTES',
);
const resource_settings = Object.fromEntries(
	[
		['max_connections', 'GUARD_MAX_CONNECTIONS', 256],
		['max_inflight_requests', 'GUARD_MAX_INFLIGHT_REQUESTS', 64],
		['rate_limit_requests', 'GUARD_RATE_LIMIT_REQUESTS', 600],
		['rate_limit_window_ms', 'GUARD_RATE_LIMIT_WINDOW_MS', 60_000],
		['body_read_timeout_ms', 'GUARD_BODY_READ_TIMEOUT_MS', 30_000],
	].map(([key, name, fallback]) => [
		key,
		parse_guard_integer(
			process.env[String(name)],
			Number(fallback),
			String(name),
			2_147_483_647,
		),
	]),
);
const api_key = require_env('MCP_API_KEY');

// Resolve the proxy's real entry point through its package.json bin
// field; node_modules/.bin holds a shell shim under pnpm, which cannot
// be spawned through process.execPath.
const proxy_pkg_path = fileURLToPath(
	new URL('../node_modules/mcp-proxy/package.json', import.meta.url),
);
const proxy_pkg = JSON.parse(readFileSync(proxy_pkg_path, 'utf8'));
const proxy_bin = join(
	dirname(proxy_pkg_path),
	proxy_pkg.bin['mcp-proxy'],
);
const server_entry = fileURLToPath(
	new URL('./index.js', import.meta.url),
);

const child: ChildProcess = spawn(
	process.execPath,
	[
		proxy_bin,
		'--host',
		upstream_host,
		'--port',
		String(upstream_port),
		'--stateless',
		'--server',
		'stream',
		'--no-eventStore',
		'--maxBodySize',
		String(max_body_bytes),
		'--',
		process.execPath,
		server_entry,
	],
	{
		stdio: ['ignore', 'inherit', 'inherit'],
		// The key travels via yargs' env prefix (MCP_PROXY_API_KEY ->
		// --apiKey) so it never appears in /proc/*/cmdline listings.
		env: { ...process.env, MCP_PROXY_API_KEY: api_key },
	},
);

const wait_for_upstream = (
	host: string,
	port: number,
	deadline_ms: number,
): Promise<void> => {
	const started = Date.now();
	const attempt = (): Promise<void> =>
		new Promise((resolve, reject) => {
			const socket = connect({ host, port }, () => {
				socket.end();
				resolve();
			});
			socket.on('error', () => {
				socket.destroy();
				if (Date.now() - started > deadline_ms) {
					reject(new Error('upstream did not start in time'));
					return;
				}
				setTimeout(() => attempt().then(resolve, reject), 100);
			});
		});
	return attempt();
};

let child_exited = false;
child.on('exit', (code, signal) => {
	child_exited = true;
	console.error(
		`guard: mcp-proxy exited (code=${code}, signal=${signal}); shutting down`,
	);
	process.exit(code ?? 1);
});

const shutdown = (signal: NodeJS.Signals) => {
	if (!child_exited) child.kill(signal);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
	if (!child_exited) child.kill('SIGTERM');
});

wait_for_upstream(upstream_host, upstream_port, 15_000)
	.then(() => {
		const server = create_guard_server(
			default_guard_config({
				upstream_host,
				upstream_port,
				allowed_hosts,
				max_body_bytes,
				api_key,
				...resource_settings,
			}),
		);
		server.listen(listen_port, listen_host, () => {
			console.error(
				`guard listening on ${listen_host}:${listen_port}, ` +
					`forwarding to ${upstream_host}:${upstream_port}`,
			);
		});
		const close_server = () => server.close();
		process.on('SIGINT', close_server);
		process.on('SIGTERM', close_server);
	})
	.catch((error) => {
		console.error(`guard: ${error.message}`);
		shutdown('SIGTERM');
		process.exit(1);
	});
