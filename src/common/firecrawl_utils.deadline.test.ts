import * as v from 'valibot';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { poll_firecrawl_job } from './firecrawl_utils.js';
import { run_with_request_context } from './request_context.js';

const fetch_mock = vi.fn();
const schema = v.object({ status: v.string() });
const options = {
	provider_name: 'firecrawl',
	status_url: 'https://api.example.com/jobs/job-1',
	api_key: 'fixture-key',
	max_attempts: 5,
	poll_interval: 10,
	timeout: 100,
};
beforeEach(() => {
	vi.useFakeTimers();
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it('does not retry or resume an unrelated timeout-shaped poll error', async () => {
	fetch_mock
		.mockResolvedValueOnce(new Response('{"status":"processing"}'))
		.mockRejectedValueOnce(
			new DOMException('Unrelated timeout', 'TimeoutError'),
		);
	const pending = poll_firecrawl_job(
		{ ...options, return_on_exhaustion: true },
		schema,
	).catch((error) => error);
	await vi.advanceTimersByTimeAsync(20);
	expect(await pending).toMatchObject({ name: 'TimeoutError' });
	await vi.advanceTimersByTimeAsync(100);
	expect(fetch_mock).toHaveBeenCalledTimes(2);
});

it('never polls early for a Retry-After larger than the timer limit', async () => {
	fetch_mock
		.mockResolvedValueOnce(new Response('{"status":"processing"}'))
		.mockResolvedValueOnce(
			new Response('{}', {
				status: 429,
				headers: { 'retry-after': '2147484' },
			}),
		)
		.mockResolvedValue(new Response('{"status":"completed"}'));
	const pending = poll_firecrawl_job(
		{ ...options, return_on_exhaustion: true },
		schema,
	);
	await vi.advanceTimersByTimeAsync(100);
	expect(await pending).toEqual({ status: 'processing' });
	expect(fetch_mock).toHaveBeenCalledTimes(2);
	expect(vi.getTimerCount()).toBe(0);
});

it.each(['request', 'body'])(
	'uses config.timeout for each GET %s with a separate overall signal',
	async (phase) => {
		const overall = new AbortController();
		fetch_mock
			.mockImplementationOnce(() =>
				phase === 'request'
					? new Promise(() => {})
					: Promise.resolve(new Response(new ReadableStream())),
			)
			.mockResolvedValueOnce(new Response('{"status":"completed"}'));
		let settled = false;
		const pending = poll_firecrawl_job(
			{ ...options, signal: overall.signal },
			schema,
		).then((result) => {
			settled = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(110);
		expect(fetch_mock.mock.calls[0][1].signal.aborted).toBe(true);
		expect(overall.signal.aborted).toBe(false);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(9);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toEqual({ status: 'completed' });
		expect(
			fetch_mock.mock.calls.map(([url, init]) => [url, init.method]),
		).toEqual([
			[options.status_url, 'GET'],
			[options.status_url, 'GET'],
		]);
		expect(vi.getTimerCount()).toBe(0);
	},
);

it('does not turn a caller timeout into a resumable success', async () => {
	const caller = new AbortController();
	fetch_mock.mockImplementation(
		async () => new Response('{"status":"processing"}'),
	);
	const pending = run_with_request_context(caller.signal, () =>
		poll_firecrawl_job(
			{ ...options, return_on_exhaustion: true },
			schema,
		),
	).catch((error) => error);
	await vi.advanceTimersByTimeAsync(10);
	caller.abort(new DOMException('Caller deadline', 'TimeoutError'));
	expect(await pending).toMatchObject({ name: 'TimeoutError' });
	await vi.advanceTimersByTimeAsync(100);
	expect(fetch_mock).toHaveBeenCalledTimes(1);
});
