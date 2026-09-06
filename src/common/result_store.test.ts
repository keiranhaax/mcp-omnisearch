import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	cleanup_expired_results,
	read_result_chunk,
	store_result,
} from './result_store.js';

let result_dir: string;

beforeEach(() => {
	result_dir = mkdtempSync(join(tmpdir(), 'omnisearch-result-test-'));
	process.env.OMNISEARCH_RESULT_DIR = result_dir;
	process.env.OMNISEARCH_RESULT_TTL_MS = '86400000';
	delete process.env.OMNISEARCH_RESULT_MAX_BYTES;
	delete process.env.OMNISEARCH_RESULT_STORE_MAX_BYTES;
});

afterEach(() => {
	delete process.env.OMNISEARCH_RESULT_DIR;
	delete process.env.OMNISEARCH_RESULT_TTL_MS;
	delete process.env.OMNISEARCH_RESULT_MAX_BYTES;
	delete process.env.OMNISEARCH_RESULT_STORE_MAX_BYTES;
	rmSync(result_dir, { recursive: true, force: true });
});

describe('remote result store', () => {
	it('stores private files and reads them by opaque ID with pagination', () => {
		const stored = store_result('line one\nline two\nline three');
		const path = join(result_dir, `${stored.result_id}.txt`);

		expect(existsSync(path)).toBe(true);
		expect(statSync(result_dir).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);

		const first = read_result_chunk(stored.result_id, 1, 2);
		expect(first.content).toBe('line one\nline two');
		expect(first.total_lines).toBe(3);
		expect(first.next_offset).toBe(3);

		const second = read_result_chunk(stored.result_id, 3, 2);
		expect(second.content).toBe('line three');
		expect(second.next_offset).toBeUndefined();
	});

	it.each([
		'🙂é漢'.repeat(20000),
		`first\n${'🙂'.repeat(10000)}\n\nlast\n`,
		`${'a'.repeat(11999)}\n${'b'.repeat(24001)}`,
	])(
		'reconstructs byte-bounded pages without skipping UTF-8 data',
		(text) => {
			const stored = store_result(text);
			let offset = 1;
			let byte_offset = 0;
			let reconstructed = '';
			const visited = new Set<string>();
			for (let page = 0; page < 100; page++) {
				const cursor = `${offset}:${byte_offset}`;
				expect(visited.has(cursor)).toBe(false);
				visited.add(cursor);
				const chunk = read_result_chunk(
					stored.result_id,
					offset,
					2,
					byte_offset,
				);
				expect(Buffer.byteLength(chunk.content)).toBeLessThanOrEqual(
					12000,
				);
				expect(chunk.content).not.toContain('\uFFFD');
				reconstructed += chunk.content;
				if (chunk.next_offset === undefined) break;
				// Legacy line pages omit their separating LF. Byte continuations do not.
				if (chunk.next_byte_offset === undefined)
					reconstructed += '\n';
				offset = chunk.next_offset;
				byte_offset = chunk.next_byte_offset ?? 0;
			}
			expect(reconstructed).toBe(text);
		},
	);

	it('rejects malformed IDs and invalid pagination bounds', () => {
		expect(() => read_result_chunk('../secret', 1, 10)).toThrow(
			'Invalid result ID',
		);
		const stored = store_result('content');
		expect(() => read_result_chunk(stored.result_id, 0, 10)).toThrow(
			'Offset must be a positive integer',
		);
		expect(() => read_result_chunk(stored.result_id, 1, 501)).toThrow(
			'Limit must be an integer between 1 and 500',
		);
	});

	it('removes expired files and refuses to return expired content', () => {
		process.env.OMNISEARCH_RESULT_TTL_MS = '1000';
		const stored = store_result('expired');
		const path = join(result_dir, `${stored.result_id}.txt`);
		const old = new Date(Date.now() - 5000);
		utimesSync(path, old, old);

		expect(cleanup_expired_results()).toBe(1);
		expect(existsSync(path)).toBe(false);
		expect(() => read_result_chunk(stored.result_id, 1, 10)).toThrow(
			'Result not found or expired',
		);
	});

	it('enforces a per-result size cap', () => {
		process.env.OMNISEARCH_RESULT_MAX_BYTES = '10';
		expect(() => store_result('12345678901')).toThrow(
			'Result exceeds the configured 10-byte storage limit',
		);
	});

	it('evicts the oldest result before exceeding the total store quota', () => {
		process.env.OMNISEARCH_RESULT_MAX_BYTES = '20';
		process.env.OMNISEARCH_RESULT_STORE_MAX_BYTES = '20';
		const first = store_result('123456789012');
		const first_path = join(result_dir, `${first.result_id}.txt`);
		const old = new Date(Date.now() - 5000);
		utimesSync(first_path, old, old);

		const second = store_result('abcdefghijkl');
		const second_path = join(result_dir, `${second.result_id}.txt`);

		expect(existsSync(first_path)).toBe(false);
		expect(existsSync(second_path)).toBe(true);
	});

	it('repairs overly broad directory permissions before storing data', () => {
		chmodSync(result_dir, 0o755);
		store_result('private');
		expect(statSync(result_dir).mode & 0o777).toBe(0o700);
	});
});
