import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ErrorType, ProviderError } from './types.js';

const DEFAULT_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_READ_LINES = 500;
const RESULT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const result_error = (message: string) =>
	new ProviderError(ErrorType.INVALID_INPUT, message, 'result_read');

const get_result_dir = () =>
	process.env.OMNISEARCH_RESULT_DIR ||
	join(homedir(), '.cache', 'mcp-omnisearch', 'results');

const get_result_ttl_ms = () => {
	const configured = Number(process.env.OMNISEARCH_RESULT_TTL_MS);
	if (!Number.isFinite(configured) || configured <= 0) {
		return DEFAULT_RESULT_TTL_MS;
	}
	return Math.min(Math.floor(configured), MAX_RESULT_TTL_MS);
};

const ensure_result_dir = () => {
	const result_dir = get_result_dir();
	mkdirSync(result_dir, { recursive: true, mode: 0o700 });
	chmodSync(result_dir, 0o700);
	return result_dir;
};

const result_path = (result_id: string) => {
	if (!RESULT_ID_PATTERN.test(result_id)) {
		throw result_error('Invalid result ID');
	}
	return join(ensure_result_dir(), `${result_id}.txt`);
};

export interface StoredResult {
	result_id: string;
	total_lines: number;
	expires_at: string;
}

export interface ResultChunk extends StoredResult {
	offset: number;
	limit: number;
	content: string;
	next_offset?: number;
}

export const cleanup_expired_results = (now = Date.now()): number => {
	const result_dir = ensure_result_dir();
	const ttl_ms = get_result_ttl_ms();
	let removed = 0;

	for (const entry of readdirSync(result_dir, {
		withFileTypes: true,
	})) {
		if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
		const id = entry.name.slice(0, -4);
		if (!RESULT_ID_PATTERN.test(id)) continue;
		const path = join(result_dir, entry.name);
		try {
			if (now - statSync(path).mtimeMs > ttl_ms) {
				unlinkSync(path);
				removed++;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error;
		}
	}

	return removed;
};

export const store_result = (content: string): StoredResult => {
	cleanup_expired_results();
	const result_dir = ensure_result_dir();
	const result_id = randomUUID();
	const path = join(result_dir, `${result_id}.txt`);
	writeFileSync(path, content, {
		encoding: 'utf8',
		flag: 'wx',
		mode: 0o600,
	});
	chmodSync(path, 0o600);
	const created_at = statSync(path).mtimeMs;

	return {
		result_id,
		total_lines:
			content.length === 0 ? 0 : content.split('\n').length,
		expires_at: new Date(
			created_at + get_result_ttl_ms(),
		).toISOString(),
	};
};

export const read_result_chunk = (
	result_id: string,
	offset = 1,
	limit = 200,
): ResultChunk => {
	if (!Number.isInteger(offset) || offset < 1) {
		throw result_error('Offset must be a positive integer');
	}
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > MAX_READ_LINES
	) {
		throw result_error(
			`Limit must be an integer between 1 and ${MAX_READ_LINES}`,
		);
	}

	const path = result_path(result_id);
	if (!existsSync(path)) {
		throw result_error('Result not found or expired');
	}

	const stats = statSync(path);
	const expires_at_ms = stats.mtimeMs + get_result_ttl_ms();
	if (Date.now() > expires_at_ms) {
		unlinkSync(path);
		throw result_error('Result not found or expired');
	}

	const text = readFileSync(path, 'utf8');
	const lines = text.length === 0 ? [] : text.split('\n');
	const start = offset - 1;
	const end = Math.min(start + limit, lines.length);

	return {
		result_id,
		offset,
		limit,
		content: lines.slice(start, end).join('\n'),
		total_lines: lines.length,
		next_offset: end < lines.length ? end + 1 : undefined,
		expires_at: new Date(expires_at_ms).toISOString(),
	};
};

export const RESULT_READ_LIMIT = MAX_READ_LINES;
