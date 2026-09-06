import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { run_with_request_context } from '../../../common/request_context.js';
import { config } from '../../../config/env.js';
import { GitHubSearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous = { ...config.search.github };
const methods = [
	'search_code',
	'search_repositories',
	'search_users',
] as const;

beforeEach(() => {
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	config.search.github.api_key = 'github-test-key';
	config.search.github.timeout = 1000;
});
afterEach(() => {
	Object.assign(config.search.github, previous);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('GitHub actual SDK requests', () => {
	it.each([403, 429])(
		'honors Retry-After for HTTP %s without SDK retries',
		async (status) => {
			vi.useFakeTimers();
			fetch_mock.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({ message: 'Rate limit exceeded' }),
						{
							status,
							headers: {
								'content-type': 'application/json',
								'retry-after': '60',
							},
						},
					),
			);
			const pending = new GitHubSearchProvider()
				.search_code({ query: 'test' })
				.catch((error) => error);
			await vi.advanceTimersByTimeAsync(500);
			const error = await pending;
			expect(error).toMatchObject({
				type: 'RATE_LIMIT',
				details: { status, reset_time: expect.any(Date) },
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);
	it('does not leak GitHub response messages and keeps HTTP status', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ message: 'private query sentinel' }),
				{
					status: 422,
					headers: { 'content-type': 'application/json' },
				},
			),
		);
		const error = await new GitHubSearchProvider()
			.search_code({ query: 'test' })
			.catch((error) => error);
		expect(error).toMatchObject({
			type: 'INVALID_INPUT',
			details: { status: 422 },
		});
		expect(error.message).not.toContain('private query sentinel');
		expect(JSON.stringify(error.details)).not.toContain(
			'private query sentinel',
		);
	});
	it.each(['hung request', 'retry wait'])(
		'enforces the whole-call deadline during a %s',
		async (mode) => {
			vi.useFakeTimers();
			config.search.github.timeout = 100;
			vi.spyOn(Math, 'random').mockReturnValue(1);
			vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
				const controller = new AbortController();
				setTimeout(
					() =>
						controller.abort(
							new DOMException('Timed out', 'TimeoutError'),
						),
					ms,
				);
				return controller.signal;
			});
			fetch_mock.mockImplementation(() =>
				mode === 'hung request'
					? new Promise(() => {})
					: Promise.resolve(
							new Response('{}', {
								status: 503,
								headers: { 'content-type': 'application/json' },
							}),
						),
			);
			let settled = false;
			const pending = new GitHubSearchProvider()
				.search_code({ query: 'test' })
				.catch((error) => {
					settled = true;
					return error;
				});
			await vi.advanceTimersByTimeAsync(110);
			expect(settled).toBe(true);
			await expect(pending).resolves.toMatchObject({
				name: 'TimeoutError',
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);
	it('bounds actual HTTP attempts to the shared retry budget', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(1);
		config.search.github.timeout = 120000;
		fetch_mock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ message: 'Service unavailable' }),
					{
						status: 503,
						headers: { 'content-type': 'application/json' },
					},
				),
		);
		const pending = new GitHubSearchProvider()
			.search_code({ query: 'test' })
			.catch((error) => error);
		await vi.advanceTimersByTimeAsync(100000);
		await expect(pending).resolves.toMatchObject({
			provider: 'github',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(2);
	});
	it.each(methods)(
		'%s receives a configured deadline and caller cancellation',
		async (method) => {
			fetch_mock.mockImplementation(
				async () =>
					new Response(JSON.stringify({ items: [] }), {
						headers: { 'content-type': 'application/json' },
					}),
			);
			const caller = new AbortController();
			const timeout_spy = vi.spyOn(AbortSignal, 'timeout');
			await run_with_request_context(caller.signal, () =>
				new GitHubSearchProvider()[method]({ query: 'C++' }),
			);
			expect(timeout_spy).toHaveBeenCalledWith(1000);
			const signal = fetch_mock.mock.calls[0][1].signal;
			expect(signal).toBeInstanceOf(AbortSignal);
			caller.abort();
			expect(signal.aborted).toBe(true);
		},
	);
});
