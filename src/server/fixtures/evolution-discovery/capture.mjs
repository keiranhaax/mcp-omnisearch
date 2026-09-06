// P0 fixture verification; --p1a allows only reviewed optional additions.
// --update refreshes P0 snapshots and cannot be combined with --p1a.
// Run only in an approved isolated worktree,
// after building the exact source revision being recorded. No provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
assert(
	process.argv
		.slice(2)
		.every((argument) => ['--update', '--p1a'].includes(argument)),
);
const update = process.argv.includes('--update');
const p1a = process.argv.includes('--p1a');
assert(
	!(update && p1a),
	'P1A verification must not overwrite P0 fixtures',
);
const additions = p1a
	? JSON.parse(
			await readFile(
				new URL(
					'../evolution-p1a/schema-additions.json',
					import.meta.url,
				),
				'utf8',
			),
		)
	: {};
const keys = [
	'TAVILY_API_KEY',
	'BRAVE_API_KEY',
	'BRAVE_ANSWERS_API_KEY',
	'EXA_API_KEY',
	'GITHUB_API_KEY',
	'YOU_API_KEY',
	'LINKUP_API_KEY',
	'FIRECRAWL_API_KEY',
	'CONTEXT_DEV_API_KEY',
];
const profiles = [
	{ name: 'all-providers', enabled: keys, count: 14 },
	{ name: 'no-providers', enabled: [], count: 1 },
	{
		name: 'no-github',
		enabled: keys.filter((key) => key !== 'GITHUB_API_KEY'),
		count: 13,
	},
	{ name: 'tavily-only', enabled: ['TAVILY_API_KEY'], count: 4 },
];
const deny_network = `
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
const deny = () => {process.stderr.write('P0_NETWORK_ATTEMPT\\n'); throw new Error('P0_NETWORK_BLOCKED');};
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
syncBuiltinESMExports();
`;

for (const profile of profiles) {
	const home = await mkdtemp(join(tmpdir(), 'omnisearch-p0-schema-'));
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		OMNISEARCH_RESULT_DIR: join(home, 'results'),
		NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(deny_network)}`,
	};
	for (const key of profile.enabled)
		env[key] = 'p0-offline-fixture-key';
	const child = spawn(process.execPath, ['dist/index.js'], {
		cwd: root,
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let logs = '';
	let pending = '';
	let bytes = 0;
	let sequence = 0;
	const requests = new Map();
	const exit = new Promise((resolve) => {
		child.once('exit', resolve);
		child.once('error', resolve);
	});
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk) => {
		logs = (logs + chunk).slice(-8000);
	});
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > 1024 * 1024) {
			child.kill('SIGTERM');
			return;
		}
		pending += chunk;
		const lines = pending.split('\n');
		pending = lines.pop();
		for (const line of lines) {
			try {
				const message = JSON.parse(line);
				requests.get(message.id)?.(message);
			} catch {
				child.kill('SIGTERM');
			}
		}
	});
	const rpc = (method, params) =>
		new Promise((resolve, reject) => {
			const id = ++sequence;
			const timer = setTimeout(() => {
				requests.delete(id);
				reject(new Error(`P0 ${method} deadline`));
			}, 5000);
			requests.set(id, (message) => {
				clearTimeout(timer);
				requests.delete(id);
				if (message.error)
					reject(new Error(`P0 ${method} RPC failure`));
				else resolve(message.result);
			});
			child.stdin.write(
				JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
			);
		});
	try {
		const initialized = await rpc('initialize', {
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: { name: 'p0-offline-schema-capture', version: '1' },
		});
		// Direct tmcp stdio negotiates this older revision at the P0 baseline.
		// The proxy supplies the separate legacy/modern HTTP contracts.
		assert.equal(initialized.protocolVersion, '2025-06-18');
		child.stdin.write(
			JSON.stringify({
				jsonrpc: '2.0',
				method: 'notifications/initialized',
			}) + '\n',
		);
		const { tools } = await rpc('tools/list', {});
		assert.equal(tools.length, profile.count);
		assert.equal(
			new Set(tools.map((tool) => tool.name)).size,
			profile.count,
		);
		assert(!logs.includes('P0_NETWORK_ATTEMPT'));
		const target = new URL(`${profile.name}.json`, import.meta.url);
		if (update)
			await writeFile(
				target,
				JSON.stringify(tools, null, '	') + '\n',
			);
		else {
			const legacy = structuredClone(tools);
			for (const tool of legacy) {
				for (const [field, schema] of Object.entries(
					additions[tool.name] ?? {},
				)) {
					assert.deepEqual(
						tool.inputSchema.properties[field],
						schema,
					);
					assert(!tool.inputSchema.required.includes(field));
					delete tool.inputSchema.properties[field];
				}
			}
			assert.deepEqual(
				legacy,
				JSON.parse(await readFile(target, 'utf8')),
			);
		}
		console.log(
			JSON.stringify({
				profile: profile.name,
				tools: tools.map((tool) => tool.name),
				count: tools.length,
				protocol: initialized.protocolVersion,
				network_attempted: false,
			}),
		);
	} finally {
		if (child.exitCode === null) child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
		await exit;
		clearTimeout(timer);
		await rm(home, { recursive: true, force: true });
	}
}
