import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	delay,
	is_retryable_error,
	retry_with_backoff,
} from './retry.js';
import { handle_provider_error } from './errors.js';
import { http_json } from './http.js';
import { run_with_request_context } from './request_context.js';
import { ErrorType, ProviderError } from './types.js';

const network_error = () =>
	new ProviderError(
		ErrorType.API_ERROR,
		'Network request failed',
		'test_provider',
		{ retryable: true, cause: 'network' },
	);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('retry_with_backoff', () => {
	it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])(
		'rejects unsafe total timeout_ms %s before work',
		async (timeout_ms) => {
			const fn = vi.fn();
			await expect(
				retry_with_backoff(fn, { timeout_ms }),
			).rejects.toThrow(RangeError);
			expect(fn).not.toHaveBeenCalled();
		},
	);
	it('keeps caller cancellation terminal with its own total budget', async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const pending = run_with_request_context(caller.signal, () =>
			retry_with_backoff(() => new Promise(() => {}), {
				timeout_ms: 100,
			}),
		).catch((error) => error);
		caller.abort();
		expect(await pending).toMatchObject({ name: 'AbortError' });
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each(['hung attempt', 'backoff'])(
		'honors optional total timeout_ms during %s',
		async (phase) => {
			vi.useFakeTimers();
			vi.spyOn(Math, 'random').mockReturnValue(1);
			const fn = vi.fn(() =>
				phase === 'hung attempt'
					? new Promise(() => {})
					: Promise.reject(network_error()),
			);
			let settled = false;
			const pending = retry_with_backoff(fn, {
				timeout_ms: 100,
			}).catch((error) => {
				settled = true;
				return error;
			});
			await vi.advanceTimersByTimeAsync(100);
			expect(settled).toBe(true);
			expect(await pending).toMatchObject({ name: 'TimeoutError' });
			expect(fn).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it('disposes a total budget when the first attempt succeeds', async () => {
		vi.useFakeTimers();
		await expect(
			retry_with_backoff(async () => 'ok', { timeout_ms: 100 }),
		).resolves.toBe('ok');
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([Infinity, NaN, -1])(
		'rejects unsafe delay %s',
		async (ms) => {
			vi.useFakeTimers();
			const result = delay(ms).catch((error) => error);
			await vi.advanceTimersByTimeAsync(1);
			expect(vi.getTimerCount()).toBe(0);
			await expect(result).resolves.toBeInstanceOf(RangeError);
		},
	);
	it('chunks a large delay without shortening it and cleans up on abort', async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		let settled = false;
		const pending = delay(2_147_483_647 + 100, caller.signal).then(
			() => {
				settled = true;
			},
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(2_147_483_647 + 99);
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		caller.abort();
		expect(await pending).toMatchObject({ name: 'AbortError' });
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([Infinity, NaN, -1])(
		'rejects unsafe initial_delay %s before work',
		async (initial_delay) => {
			const fn = vi.fn().mockResolvedValue('ok');
			await expect(
				retry_with_backoff(fn, { initial_delay }),
			).rejects.toThrow(RangeError);
			expect(fn).not.toHaveBeenCalled();
		},
	);
	it('does not retry unclassified application TypeErrors', () => {
		expect(is_retryable_error(new TypeError('mapping failed'))).toBe(
			false,
		);
	});
	it('does not shorten a Retry-After outside the bounded wait budget', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
		const error = new ProviderError(
			ErrorType.RATE_LIMIT,
			'limited',
			'test_provider',
			{
				reset_time: new Date('2026-09-05T12:01:00Z'),
			},
		);
		const fn = vi.fn().mockRejectedValue(error);
		await expect(retry_with_backoff(fn)).rejects.toBe(error);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		[429, '8640000000001'],
		[429, '9'.repeat(400)],
		[503, '8640000000001'],
		[503, '9'.repeat(400)],
	])(
		'does not retry HTTP %s with enormous Retry-After seconds %s',
		async (status, retry_after) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const fetch_mock = vi
				.fn()
				.mockResolvedValueOnce(
					new Response('wait', {
						status: Number(status),
						headers: { 'Retry-After': String(retry_after) },
					}),
				)
				.mockResolvedValueOnce(new Response('{"ok":true}'));
			vi.stubGlobal('fetch', fetch_mock);
			const result = retry_with_backoff(() =>
				http_json('test_provider', 'https://api.example.com'),
			).catch((error: unknown) => error);
			await vi.runAllTimersAsync();
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			expect(await result).toMatchObject({
				details: { status: Number(status) },
			});
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([Infinity, NaN, -1, 0.5, 1000000])(
		'rejects unsafe retry counts %s before calling the provider',
		async (max_retries) => {
			const fn = vi.fn().mockResolvedValue('ok');
			await expect(
				retry_with_backoff(fn, { max_retries }),
			).rejects.toThrow(RangeError);
			expect(fn).not.toHaveBeenCalled();
		},
	);
	it.each(['request', 'call'] as const)(
		'cancels the current non-cooperative attempt from the %s signal',
		async (source) => {
			vi.useFakeTimers();
			const request = new AbortController();
			const call = new AbortController();
			const fn = vi.fn(() => new Promise(() => {}));
			let outcome: unknown;
			const result = run_with_request_context(request.signal, () =>
				retry_with_backoff(fn, { signal: call.signal }),
			).catch((error: unknown) => {
				outcome = error;
			});
			(source === 'request' ? request : call).abort('PRIVATE_REASON');
			await vi.advanceTimersByTimeAsync(0);
			expect(outcome).toMatchObject({
				name: 'AbortError',
				message: 'Operation cancelled',
			});
			await result;
			expect(fn).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(['request', 'call'] as const)(
		'propagates the %s retry signal to nested HTTP',
		async (source) => {
			vi.useFakeTimers();
			const request = new AbortController();
			const call = new AbortController();
			let fetch_signal: AbortSignal | undefined;
			const fetch_mock = vi.fn((_url, options) => {
				fetch_signal = options.signal;
				return new Promise(() => {});
			});
			vi.stubGlobal('fetch', fetch_mock);
			let outcome: unknown;
			const result = run_with_request_context(request.signal, () =>
				retry_with_backoff(
					() => http_json('test_provider', 'https://api.example.com'),
					{ signal: call.signal },
				),
			).catch((error: unknown) => {
				outcome = error;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			(source === 'request' ? request : call).abort('PRIVATE_REASON');
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch_signal?.aborted).toBe(true);
			expect(outcome).toMatchObject({
				name: 'AbortError',
				message: 'Operation cancelled',
			});
			await result;
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(['request', 'call'] as const)(
		'stops backoff immediately when the %s signal is cancelled',
		async (source) => {
			vi.useFakeTimers();
			vi.spyOn(Math, 'random').mockReturnValue(1);
			const request = new AbortController();
			const call = new AbortController();
			const fn = vi.fn().mockRejectedValue(network_error());
			const result = run_with_request_context(request.signal, () =>
				retry_with_backoff(fn, { signal: call.signal }),
			);
			const rejected = expect(result).rejects.toMatchObject({
				name: 'AbortError',
			});
			await vi.advanceTimersByTimeAsync(1);
			(source === 'request' ? request : call).abort();
			await rejected;
			expect(fn).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it.each(['2', 'Sat, 05 Sep 2026 12:00:02 GMT'])(
		'honors Retry-After %s as a minimum wait',
		async (retry_after) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
			vi.spyOn(Math, 'random').mockReturnValue(0);
			const fetch_mock = vi
				.fn()
				.mockResolvedValueOnce(
					new Response('slow down', {
						status: 429,
						headers: { 'Retry-After': retry_after },
					}),
				)
				.mockResolvedValueOnce(new Response('{"ok":true}'));
			vi.stubGlobal('fetch', fetch_mock);
			const result = retry_with_backoff(() =>
				http_json('test_provider', 'https://api.example.com'),
			);
			await vi.advanceTimersByTimeAsync(1999);
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(result).resolves.toEqual({ ok: true });
			expect(fetch_mock).toHaveBeenCalledTimes(2);
		},
	);
	it.each(['headers', 'body'])(
		'retries %s network failures wrapped by the provider catch path',
		async (phase) => {
			vi.useFakeTimers();
			const failure = new TypeError('private signed URL');
			const fetch_mock = vi.fn();
			if (phase === 'headers') {
				fetch_mock.mockRejectedValueOnce(failure);
			} else {
				fetch_mock.mockResolvedValueOnce(
					new Response(
						new ReadableStream({
							start(controller) {
								controller.error(failure);
							},
						}),
					),
				);
			}
			fetch_mock.mockResolvedValueOnce(new Response('{"ok":true}'));
			vi.stubGlobal('fetch', fetch_mock);
			const result = retry_with_backoff(async () => {
				try {
					return await http_json(
						'test_provider',
						'https://api.example.com',
					);
				} catch (error) {
					handle_provider_error(error, 'test_provider', 'search');
				}
			});
			const resolved = expect(result).resolves.toEqual({ ok: true });
			await vi.runAllTimersAsync();
			await resolved;
			expect(fetch_mock).toHaveBeenCalledTimes(2);
		},
	);
	it('returns immediately when the operation succeeds on the first try', async () => {
		const fn = vi.fn().mockResolvedValue('ok');

		await expect(retry_with_backoff(fn)).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retries transient errors with jittered exponential backoff', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(1);
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(network_error())
			.mockRejectedValueOnce(
				new ProviderError(
					ErrorType.RATE_LIMIT,
					'rate limited',
					'test',
				),
			)
			.mockResolvedValueOnce('ok');

		const promise = retry_with_backoff(fn, 3, 100);
		const resolution = expect(promise).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
		// Jittered delay is in [0, 100]; advancing by the ceiling covers it
		await vi.advanceTimersByTimeAsync(100);
		expect(fn).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(200);
		expect(fn).toHaveBeenCalledTimes(3);
		await resolution;
	});

	it('rethrows the final retryable error after exhausting retries', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(1);
		const error = network_error();
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(error);
		const promise = retry_with_backoff(fn, 2, 50);
		const rejection = expect(promise).rejects.toBe(error);

		expect(fn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(50);
		expect(fn).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(100);
		expect(fn).toHaveBeenCalledTimes(3);
		await rejection;
	});

	it('does not retry generic errors or timeouts', async () => {
		const timeout_error = new Error('operation timed out');
		timeout_error.name = 'TimeoutError';
		for (const error of [new Error('unknown'), timeout_error]) {
			const fn = vi
				.fn<() => Promise<string>>()
				.mockRejectedValue(error);

			await expect(retry_with_backoff(fn)).rejects.toBe(error);
			expect(fn).toHaveBeenCalledTimes(1);
		}
	});

	it('does not retry permanent provider errors', async () => {
		for (const type of [
			ErrorType.INVALID_INPUT,
			ErrorType.ENTITLEMENT_REQUIRED,
			ErrorType.ENDPOINT_NOT_FOUND,
		]) {
			const error = new ProviderError(type, 'permanent', 'test');
			const fn = vi
				.fn<() => Promise<string>>()
				.mockRejectedValue(error);

			await expect(retry_with_backoff(fn)).rejects.toBe(error);
			expect(fn).toHaveBeenCalledTimes(1);
		}
	});

	it('does not retry provider errors explicitly marked non-retryable', async () => {
		const error = new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'malformed provider response',
			'test',
			{ retryable: false },
		);
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(error);

		await expect(retry_with_backoff(fn)).rejects.toBe(error);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('does not retry HTTP 4xx API errors', async () => {
		const error = new ProviderError(
			ErrorType.API_ERROR,
			'bad request',
			'test',
			{ status: 400 },
		);
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(error);

		await expect(retry_with_backoff(fn)).rejects.toBe(error);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('allows retries to be disabled for costly job creation', async () => {
		const error = new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'transient but costly',
			'firecrawl_agent',
		);
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValue(error);

		await expect(
			retry_with_backoff(fn, { max_retries: 0 }),
		).rejects.toBe(error);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
