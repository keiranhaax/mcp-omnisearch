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
});

afterEach(() => {
	delete process.env.OMNISEARCH_RESULT_DIR;
	delete process.env.OMNISEARCH_RESULT_TTL_MS;
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

	it('repairs overly broad directory permissions before storing data', () => {
		chmodSync(result_dir, 0o755);
		store_result('private');
		expect(statSync(result_dir).mode & 0o777).toBe(0o700);
	});
});
