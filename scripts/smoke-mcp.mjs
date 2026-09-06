import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const unusedPort = async () => {
	const socket = createServer();
	await new Promise((resolve) =>
		socket.listen(0, '127.0.0.1', resolve),
	);
	const { port } = socket.address();
	await new Promise((resolve) => socket.close(resolve));
	return port;
};

const home = await mkdtemp(join(tmpdir(), 'omnisearch-smoke-'));
const [port, upstreamPort] = await Promise.all([
	unusedPort(),
	unusedPort(),
]);
assert.notEqual(port, upstreamPort);
const key = randomUUID();
const url = `http://127.0.0.1:${port}`;
const checks = [];
const env = {
	PATH: process.env.PATH,
	HOME: home,
	NODE_ENV: 'test',
	MCP_API_KEY: key,
	GUARD_LISTEN_HOST: '127.0.0.1',
	GUARD_LISTEN_PORT: String(port),
	GUARD_UPSTREAM_PORT: String(upstreamPort),
	GUARD_ALLOWED_HOSTS: `127.0.0.1:${port}`,
	OMNISEARCH_RESULT_DIR: join(home, 'results'),
	// No network provider request is allowed from either child process.
	NODE_OPTIONS:
		'--import=data:text/javascript,globalThis.fetch=async()=>{console.error("OFFLINE_SMOKE_NETWORK_ATTEMPT");throw%20new%20Error("OFFLINE_SMOKE_NETWORK_BLOCKED")}',
};
for (const name of [
	'TAVILY_API_KEY',
	'BRAVE_API_KEY',
	'BRAVE_ANSWERS_API_KEY',
	'EXA_API_KEY',
	'GITHUB_API_KEY',
	'YOU_API_KEY',
	'LINKUP_API_KEY',
	'FIRECRAWL_API_KEY',
	'CONTEXT_DEV_API_KEY',
])
	env[name] = 'offline-fixture-key';

const child = spawn(process.execPath, ['dist/guard.js'], {
	env,
	stdio: ['ignore', 'ignore', 'pipe'],
});
let logs = '';
child.stderr.on('data', (chunk) => {
	logs = (logs + chunk).slice(-8000);
});
const exit = new Promise((resolve) => child.once('exit', resolve));
const meta = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientInfo': {
		name: 'offline-smoke',
		version: '1',
	},
	'io.modelcontextprotocol/clientCapabilities': {},
};
let id = 0;
const rpc = async (
	method,
	params = {},
	modern = false,
	headers = {},
) => {
	const response = await fetch(`${url}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'X-API-Key': key,
			'MCP-Protocol-Version': modern ? '2026-07-28' : '2025-11-25',
			...(modern
				? {
						'Mcp-Method': method,
						...(params.name || params.uri
							? { 'Mcp-Name': params.name || params.uri }
							: {}),
					}
				: {}),
			...headers,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: ++id,
			method,
			params: { ...params, ...(modern ? { _meta: meta } : {}) },
		}),
		signal: AbortSignal.timeout(5000),
	});
	const raw = await response.text();
	const data = response.headers
		.get('content-type')
		?.includes('text/event-stream')
		? raw
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => JSON.parse(line.slice(5)))
				.at(-1)
		: JSON.parse(raw);
	return { response, data };
};

try {
	let ready = false;
	for (let attempt = 0; attempt < 60; attempt++) {
		if (child.exitCode !== null)
			throw new Error('Guard exited during startup');
		try {
			const response = await fetch(`${url}/ping`, {
				signal: AbortSignal.timeout(300),
			});
			if (response.ok && (await response.text()) === 'pong') {
				ready = true;
				break;
			}
		} catch {
			/* Retry only the temporary instance's bounded startup. */
		}
		await delay(100);
	}
	assert(ready, 'guard readiness deadline');
	checks.push('ping');
	const readiness = await fetch(`${url}/ready`, {
		signal: AbortSignal.timeout(3000),
	});
	assert.equal(readiness.status, 200);
	assert.equal((await readiness.json()).status, 'ready');
	checks.push('upstream-readiness');
	for (const wrong of ['', 'invalid']) {
		const { response } = await rpc('tools/list', {}, false, {
			'X-API-Key': wrong,
		});
		assert.equal(response.status, 401);
		assert.equal(
			response.headers.get('www-authenticate'),
			'ApiKey realm="omnisearch"',
		);
	}
	checks.push('authentication');
	for (const headers of [
		{ Host: 'invalid.example' },
		{ Origin: 'https://invalid.example' },
	]) {
		const status = await new Promise((resolve, reject) => {
			const request = httpRequest(
				`${url}/ping`,
				{ headers },
				(response) => {
					response.resume();
					response.once('end', () => resolve(response.statusCode));
				},
			);
			request.setTimeout(5000, () =>
				request.destroy(new Error('Host/Origin probe timed out')),
			);
			request.once('error', reject);
			request.end();
		});
		assert.equal(status, 403);
	}
	checks.push('host-origin');
	assert.equal((await fetch(`${url}/sse`)).status, 404);
	assert.equal((await fetch(`${url}/mcp`)).status, 405);
	checks.push('routes');
	const initialized = await rpc('initialize', {
		protocolVersion: '2025-11-25',
		capabilities: {},
		clientInfo: { name: 'offline-smoke', version: '1' },
	});
	assert.equal(initialized.response.status, 200);
	assert.equal(initialized.data.result.protocolVersion, '2025-11-25');
	const legacy = (await rpc('tools/list')).data.result.tools;
	const modern = (await rpc('tools/list', {}, true)).data.result
		.tools;
	assert.equal(legacy.length, 14);
	assert.deepEqual(
		modern.map((t) => t.name),
		legacy.map((t) => t.name),
	);
	assert.equal(new Set(legacy.map((t) => t.name)).size, 14);
	checks.push('legacy-and-modern-14-tools');
	for (const modern of [false, true]) {
		const unknown = await rpc(
			'tools/call',
			{ name: 'missing-fixture-tool', arguments: {} },
			modern,
		);
		assert.equal(unknown.data.error.code, -32602);
		const missing = await rpc(
			'resources/read',
			{ uri: 'fixture://missing' },
			modern,
		);
		assert.equal(missing.data.error.code, -32602);
		const invalid = await rpc(
			'tools/call',
			{
				name: 'web_search',
				arguments: {
					query: 'PRIVATE_FIXTURE_SENTINEL'.repeat(10000),
					provider: 'brave',
				},
			},
			modern,
		);
		const serialized = JSON.stringify(invalid.data);
		assert.equal(invalid.data.result.isError, true);
		assert(Buffer.byteLength(serialized) < 12000);
		assert(!serialized.includes('PRIVATE_FIXTURE_SENTINEL'));
	}
	checks.push('bounded-validation-and-protocol-errors');
	assert.equal(
		(await rpc('server/discover', {}, true)).data.result.resultType,
		'complete',
	);
	const templates = (await rpc('resources/templates/list', {}, true))
		.data.result.resourceTemplates;
	assert(
		templates.some(
			(t) => t.uriTemplate === 'omnisearch://search/{provider}/info',
		),
	);
	const info = await rpc(
		'resources/read',
		{ uri: 'omnisearch://search/brave/info' },
		true,
	);
	assert.equal(
		JSON.parse(info.data.result.contents[0].text).name,
		'brave',
	);
	checks.push('resource-template-dispatch');
	const storedId = randomUUID();
	const storedText = 'α😀 one\n'.repeat(9000);
	await writeFile(
		join(home, 'results', `${storedId}.txt`),
		storedText,
		{ mode: 0o600 },
	);
	let reconstructed = '';
	let offset = 1;
	let byteOffset = 0;
	for (let page = 0; page < 100; page++) {
		const result = await rpc(
			'tools/call',
			{
				name: 'result_read',
				arguments: {
					result_id: storedId,
					offset,
					byte_offset: byteOffset,
					limit: 500,
				},
			},
			page % 2 === 0,
		);
		assert(!result.data.result.isError);
		assert(Buffer.byteLength(JSON.stringify(result.data)) < 100000);
		const chunk = JSON.parse(result.data.result.content[0].text);
		reconstructed += chunk.content;
		if (chunk.next_offset === undefined) break;
		if (chunk.next_byte_offset === undefined) reconstructed += '\n';
		offset = chunk.next_offset;
		byteOffset = chunk.next_byte_offset ?? 0;
	}
	assert.equal(reconstructed, storedText);
	checks.push('utf8-lossless-bounded-pagination');
	const mismatch = await rpc('tools/list', {}, true, {
		'Mcp-Method': 'resources/list',
	});
	assert.equal(mismatch.response.status, 400);
	checks.push('modern-header-body-validation');
	const batch = await fetch(`${url}/mcp`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
		body: '[]',
		signal: AbortSignal.timeout(5000),
	});
	assert.equal(batch.status, 400);
	await batch.text();
	checks.push('batch-rejection');
	for (const modern of [false, true]) {
		const result = await rpc(
			'tools/call',
			{
				name: 'firecrawl_agent',
				arguments: { prompt: 'offline', max_credits: 0 },
			},
			modern,
		);
		assert.equal(result.data.result.isError, true);
		assert(
			!JSON.stringify(result.data).includes(
				'OFFLINE_SMOKE_NETWORK_BLOCKED',
			),
		);
	}
	checks.push('invalid-budget-rejected-before-network');
	assert(
		!logs.includes('OFFLINE_SMOKE_NETWORK_ATTEMPT'),
		'provider networking was attempted',
	);
	console.log(
		JSON.stringify({ passed: checks, count: checks.length }),
	);
} catch (error) {
	console.error(logs.replaceAll(key, '[redacted]'));
	throw error;
} finally {
	if (child.exitCode === null) child.kill('SIGTERM');
	const exited = await Promise.race([
		exit.then(() => true),
		delay(7000).then(() => false),
	]);
	if (!exited) {
		child.kill('SIGKILL');
		await exit;
	}
	await rm(home, { recursive: true, force: true });
	assert(exited, 'temporary guard did not shut down cleanly');
}
