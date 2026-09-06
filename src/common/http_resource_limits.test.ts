import { afterEach, describe, expect, it, vi } from 'vitest';
import { http_json } from './http.js';
import {
	consume_response_bytes,
	MAX_REQUEST_RESPONSE_BYTES,
	run_with_request_context,
} from './request_context.js';

afterEach(() => vi.unstubAllGlobals());

describe('HTTP resource admission', () => {
	it('keeps provider capacity until an abort-ignoring fetch actually settles', async () => {
		const releases: (() => void)[] = [];
		const fetch_mock = vi.fn(async () => {
			await new Promise<void>((resolve) => releases.push(resolve));
			return new Response('{}');
		});
		vi.stubGlobal('fetch', fetch_mock);
		const controllers = Array.from(
			{ length: 4 },
			() => new AbortController(),
		);
		const first = controllers.map((controller) =>
			http_json('held-fixture', 'https://example.com', {
				signal: controller.signal,
			}).catch((error) => error),
		);
		await vi.waitFor(() =>
			expect(fetch_mock).toHaveBeenCalledTimes(4),
		);
		controllers.forEach((controller) => controller.abort());
		expect(
			(await Promise.all(first)).every(
				(error) => error.name === 'AbortError',
			),
		).toBe(true);
		const extra_controller = new AbortController();
		const extra = http_json('held-fixture', 'https://example.com', {
			signal: extra_controller.signal,
		}).catch((error) => error);
		await new Promise((resolve) => setTimeout(resolve, 10));
		try {
			expect(fetch_mock).toHaveBeenCalledTimes(4);
		} finally {
			extra_controller.abort();
			for (const release of releases) release();
			await extra;
		}
	});
	it('bounds simultaneous fetches across adapters sharing a provider', async () => {
		const releases: (() => void)[] = [];
		let active = 0;
		let peak = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise<void>((resolve) => releases.push(resolve));
				active--;
				return new Response('{}');
			}),
		);
		const pending = [
			'firecrawl_scrape',
			'firecrawl_map',
			'firecrawl_crawl',
			'firecrawl_extract',
			'firecrawl_agent',
		].map((provider) => http_json(provider, 'https://example.com'));
		try {
			await vi.waitFor(() => expect(releases).toHaveLength(4));
			expect(peak).toBe(4);
			releases.shift()!();
			await vi.waitFor(() => expect(releases).toHaveLength(4));
			for (const release of releases) release();
			await Promise.all(pending);
			expect(peak).toBe(4);
		} finally {
			for (const release of releases) release();
			await Promise.allSettled(pending);
		}
	});
	it('enforces aggregate bytes through the real bounded HTTP body reader', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}')),
		);
		await expect(
			run_with_request_context(undefined, async () => {
				consume_response_bytes(MAX_REQUEST_RESPONSE_BYTES - 1);
				return http_json('fixture', 'https://example.com');
			}),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			details: { retryable: false },
		});
	});
});
