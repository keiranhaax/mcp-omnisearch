import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { TavilyResearchProvider } from './index.js';
import { run_with_request_context } from '../../../common/request_context.js';

const fetch_mock = vi.fn();
const pending_fetch = (
	_url: unknown,
	options: RequestInit,
): Promise<Response> =>
	new Promise((_resolve, reject) => {
		const signal = options.signal!;
		if (signal.aborted) reject(signal.reason);
		else
			signal.addEventListener('abort', () => reject(signal.reason), {
				once: true,
			});
	});
const previous = { ...config.ai_response.tavily_research };
const json_response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});

beforeEach(() => {
	vi.useFakeTimers();
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
	config.ai_response.tavily_research.api_key = 'tavily-test-key';
	config.ai_response.tavily_research.timeout = 20000;
});
afterEach(() => {
	Object.assign(config.ai_response.tavily_research, previous);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('Tavily research polling', () => {
	it('rejects a mismatched status ID without exposing another task report', async () => {
		fetch_mock.mockResolvedValueOnce(
			json_response({
				request_id: 'other-job',
				status: 'completed',
				content: 'PRIVATE_OTHER_REPORT',
			}),
		);
		const error = await new TavilyResearchProvider()
			.status({ request_id: 'job-1' })
			.catch((error) => error);
		expect(error).toMatchObject({
			type: 'PROVIDER_ERROR',
			details: { retryable: false, request_id: 'job-1' },
		});
		expect(JSON.stringify(error)).not.toContain(
			'PRIVATE_OTHER_REPORT',
		);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
	it.each(['failed', 'error'])(
		'stops an accepted %s creation status immediately',
		async (status) => {
			fetch_mock.mockResolvedValueOnce(
				json_response({ status, request_id: 'job-1' }),
			);
			const pending = new TavilyResearchProvider()
				.search({ query: 'test' })
				.catch((error) => error);
			await vi.advanceTimersByTimeAsync(1);
			expect(await pending).toMatchObject({
				type: 'PROVIDER_ERROR',
				details: { retryable: false, request_id: 'job-1' },
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);
	describe('per-poll timeouts', () => {
		beforeEach(() => {
			config.ai_response.tavily_research.timeout = 60000;
			// Native AbortSignal.timeout does not follow fake timers.
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
		});

		it.each(['request', 'response body'])(
			'resumes the same job after a poll %s times out',
			async (phase) => {
				fetch_mock
					.mockResolvedValueOnce(
						json_response({ status: 'pending', request_id: 'job-1' }),
					)
					.mockImplementationOnce((url, options) => {
						if (phase === 'request')
							return pending_fetch(url, options);
						return Promise.resolve(
							new Response(new ReadableStream()),
						);
					})
					.mockResolvedValueOnce(
						json_response({
							status: 'completed',
							request_id: 'job-1',
							content: 'Recovered report',
						}),
					);
				let settled = false;
				const pending = new TavilyResearchProvider()
					.search({ query: 'test' })
					.then(
						(result) => {
							settled = true;
							return result;
						},
						(error) => {
							settled = true;
							return error;
						},
					);
				await vi.advanceTimersByTimeAsync(20000);
				expect(fetch_mock).toHaveBeenCalledTimes(2);
				expect(fetch_mock.mock.calls[1][1].signal.aborted).toBe(true);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(4999);
				expect(fetch_mock).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(1);
				await expect(pending).resolves.toMatchObject([
					{ snippet: 'Recovered report' },
				]);
				expect(
					fetch_mock.mock.calls.map(([url, options]) => [
						url,
						options.method,
					]),
				).toEqual([
					[
						`${config.ai_response.tavily_research.base_url}/research`,
						'POST',
					],
					[
						`${config.ai_response.tavily_research.base_url}/research/job-1`,
						'GET',
					],
					[
						`${config.ai_response.tavily_research.base_url}/research/job-1`,
						'GET',
					],
				]);
			},
		);

		it('bounds repeated poll timeouts by the original deadline', async () => {
			config.ai_response.tavily_research.timeout = 35000;
			fetch_mock
				.mockResolvedValueOnce(
					json_response({ status: 'pending', request_id: 'job-1' }),
				)
				.mockImplementation(pending_fetch);
			let settled = false;
			const pending = new TavilyResearchProvider()
				.search({ query: 'test' })
				.then(
					(result) => {
						settled = true;
						return result;
					},
					(error) => {
						settled = true;
						return error;
					},
				);
			await vi.advanceTimersByTimeAsync(34999);
			expect(settled).toBe(false);
			expect(fetch_mock).toHaveBeenCalledTimes(3);
			expect(fetch_mock.mock.calls[2][1].signal.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toBe(true);
			await expect(pending).resolves.toMatchObject([
				{
					metadata: {
						request_id: 'job-1',
						status: 'pending',
						resumable: true,
					},
				},
			]);
			expect(fetch_mock.mock.calls[2][1].signal.aborted).toBe(true);
			await vi.advanceTimersByTimeAsync(60000);
			expect(fetch_mock).toHaveBeenCalledTimes(3);
			expect(
				fetch_mock.mock.calls.map(([, options]) => options.method),
			).toEqual(['POST', 'GET', 'GET']);
		});

		it.each([
			{ at: 10000, name: 'AbortError' },
			{ at: 20000, name: 'AbortError' },
			{ at: 22000, name: 'AbortError' },
			{ at: 27000, name: 'TimeoutError' },
		])(
			'honors caller $name at $at ms without further polls',
			async ({ at, name }) => {
				fetch_mock
					.mockResolvedValueOnce(
						json_response({ status: 'pending', request_id: 'job-1' }),
					)
					.mockImplementation(pending_fetch);
				const caller = new AbortController();
				setTimeout(
					() =>
						caller.abort(new DOMException('Caller stopped', name)),
					at,
				);
				const pending = run_with_request_context(caller.signal, () =>
					new TavilyResearchProvider().search({ query: 'test' }),
				).catch((error) => error);
				await vi.advanceTimersByTimeAsync(at);
				await expect(pending).resolves.toMatchObject({
					name: 'ProviderError',
					type: 'API_ERROR',
					details: {
						request_id: 'job-1',
						cause: name === 'TimeoutError' ? 'timeout' : 'cancelled',
						retryable: false,
					},
				});
				const expected_calls = at < 25000 ? 2 : 3;
				expect(fetch_mock).toHaveBeenCalledTimes(expected_calls);
				await vi.advanceTimersByTimeAsync(60000);
				expect(fetch_mock).toHaveBeenCalledTimes(expected_calls);
			},
		);

		it('does not retry a timed-out paid start request', async () => {
			fetch_mock.mockImplementation(pending_fetch);
			const pending = new TavilyResearchProvider()
				.search({ query: 'test' })
				.catch((error) => error);
			await vi.advanceTimersByTimeAsync(30000);
			await expect(pending).resolves.toMatchObject({
				type: 'API_ERROR',
				details: { retryable: false, cause: 'timeout' },
			});
			await vi.advanceTimersByTimeAsync(60000);
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		});

		it('does not retry a timeout error unrelated to its poll timer', async () => {
			fetch_mock
				.mockResolvedValueOnce(
					json_response({ status: 'pending', request_id: 'job-1' }),
				)
				.mockRejectedValueOnce(
					new DOMException('Other timeout', 'TimeoutError'),
				);
			const pending = new TavilyResearchProvider()
				.search({ query: 'test' })
				.catch((error) => error);
			await vi.advanceTimersByTimeAsync(5000);
			await expect(pending).resolves.toMatchObject({
				type: 'API_ERROR',
				details: { retryable: false, cause: 'timeout' },
			});
			await vi.advanceTimersByTimeAsync(60000);
			expect(fetch_mock).toHaveBeenCalledTimes(2);
		});

		it('still honors Retry-After following a timed-out poll', async () => {
			fetch_mock
				.mockResolvedValueOnce(
					json_response({ status: 'pending', request_id: 'job-1' }),
				)
				.mockImplementationOnce(pending_fetch)
				.mockResolvedValueOnce(
					new Response('{}', {
						status: 429,
						headers: { 'retry-after': '10' },
					}),
				)
				.mockResolvedValueOnce(
					json_response({
						status: 'completed',
						request_id: 'job-1',
						content: 'Report',
					}),
				);
			const pending = new TavilyResearchProvider().search({
				query: 'test',
			});
			await vi.advanceTimersByTimeAsync(25000);
			expect(fetch_mock).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(14999);
			expect(fetch_mock).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toMatchObject([
				{ snippet: 'Report' },
			]);
			expect(
				fetch_mock.mock.calls.map(([, options]) => options.method),
			).toEqual(['POST', 'GET', 'GET', 'GET']);
		});
	});
	it('does not poll before Retry-After or recreate a throttled task', async () => {
		fetch_mock
			.mockResolvedValueOnce(
				json_response({ status: 'pending', request_id: 'job-1' }),
			)
			.mockImplementation(
				async () =>
					new Response('{}', {
						status: 429,
						headers: { 'retry-after': '60' },
					}),
			);
		let error: any;
		const pending = new TavilyResearchProvider()
			.search({ query: 'test' })
			.catch((caught) => {
				error = caught;
			});
		await vi.advanceTimersByTimeAsync(6000);
		expect(error?.type).toBe('RATE_LIMIT');
		expect(error?.details?.request_id).toBe('job-1');
		await pending;
		expect(fetch_mock).toHaveBeenCalledTimes(2);
	});
	it('keeps the default report response non-streaming', async () => {
		fetch_mock
			.mockResolvedValueOnce(
				json_response({ status: 'pending', request_id: 'job-1' }),
			)
			.mockResolvedValueOnce(
				json_response({
					status: 'completed',
					request_id: 'job-1',
					content: 'Report',
					sources: [{ title: 'Source', url: 'https://example.com' }],
					response_time: 1.2,
				}),
			);
		const pending = new TavilyResearchProvider().search({
			query: 'test',
		});
		await vi.advanceTimersByTimeAsync(5001);
		await expect(pending).resolves.toMatchObject([
			{ snippet: 'Report' },
			{ url: 'https://example.com' },
		]);
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({ stream: false });
	});
	it('cancels the poll wait without making another request', async () => {
		fetch_mock.mockResolvedValueOnce(
			json_response({ status: 'pending', request_id: 'job-1' }),
		);
		const caller = new AbortController();
		const pending = run_with_request_context(caller.signal, () =>
			new TavilyResearchProvider().search({ query: 'test' }),
		).catch((error) => error);
		await vi.advanceTimersByTimeAsync(1);
		caller.abort();
		await expect(pending).resolves.toMatchObject({
			name: 'ProviderError',
			details: {
				request_id: 'job-1',
				cause: 'cancelled',
				retryable: false,
			},
		});
		await vi.advanceTimersByTimeAsync(6000);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
	it.each([
		null,
		{ request_id: 42, status: 'pending' },
		{ request_id: 'job-1', status: 42 },
	])(
		'rejects a malformed start response without polling: %o',
		async (body) => {
			fetch_mock.mockResolvedValueOnce(json_response(body));
			let error: any;
			new TavilyResearchProvider()
				.search({ query: 'test' })
				.catch((caught) => {
					error = caught;
				});
			await vi.advanceTimersByTimeAsync(1);
			expect(error).toMatchObject({
				type: 'PROVIDER_ERROR',
				details: { retryable: false },
				message: 'Malformed tavily_research response',
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);
	it.each([
		null,
		{ status: 42 },
		{ status: 'completed', content: 42 },
		{ status: 'completed', content: 'Report', sources: {} },
	])('rejects a malformed polling response: %o', async (body) => {
		fetch_mock
			.mockResolvedValueOnce(
				json_response({ request_id: 'job-1', status: 'pending' }),
			)
			.mockResolvedValueOnce(json_response(body));
		let error: any;
		new TavilyResearchProvider()
			.search({ query: 'test' })
			.catch((caught) => {
				error = caught;
			});
		await vi.advanceTimersByTimeAsync(5001);
		expect(error).toMatchObject({
			type: 'PROVIDER_ERROR',
			details: { retryable: false },
			message: 'Malformed tavily_research response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(2);
	});
	it.each(['failed', 'error'])(
		'returns a private-safe permanent %s task error',
		async (status) => {
			fetch_mock
				.mockResolvedValueOnce(
					json_response({ request_id: 'job-1', status: 'pending' }),
				)
				.mockResolvedValueOnce(
					json_response({
						request_id: 'job-1',
						status,
						content: 'private query sentinel',
					}),
				);
			const pending = new TavilyResearchProvider()
				.search({ query: 'test' })
				.catch((error) => error);
			await vi.advanceTimersByTimeAsync(5001);
			const error = await pending;
			expect(error).toMatchObject({
				type: 'PROVIDER_ERROR',
				details: { retryable: false },
			});
			expect(error.message).not.toContain('private query sentinel');
			expect(fetch_mock).toHaveBeenCalledTimes(2);
		},
	);
	it.each(['start request', 'response body', 'poll wait'])(
		'honors one deadline during %s without starting a late poll',
		async (phase) => {
			config.ai_response.tavily_research.timeout = 100;
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
			fetch_mock.mockImplementation((url, options) => {
				if (phase === 'start request')
					return pending_fetch(url, options);
				if (phase === 'response body')
					return Promise.resolve(new Response(new ReadableStream()));
				const response = json_response({
					status: 'pending',
					request_id: 'job-1',
				});

				return Promise.resolve(response);
			});
			let settled = false;
			const pending = new TavilyResearchProvider()
				.search({ query: 'test' })
				.catch((error) => {
					settled = true;
					return error;
				});
			await vi.advanceTimersByTimeAsync(110);
			if (phase === 'poll wait') {
				expect(await pending).toMatchObject([
					{ metadata: { request_id: 'job-1', resumable: true } },
				]);
			} else {
				expect(settled).toBe(true);
				expect(await pending).toMatchObject({
					details: { cause: 'timeout' },
				});
			}
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);
	it.each([401, 403, 404, 422])(
		'stops polling a permanent HTTP %s without recreating the job',
		async (status) => {
			fetch_mock
				.mockResolvedValueOnce(
					json_response({ status: 'pending', request_id: 'job-1' }),
				)
				.mockImplementation(async () =>
					json_response({ error: 'Request rejected' }, status),
				);
			let error: any;
			const pending = new TavilyResearchProvider()
				.search({ query: 'test' })
				.catch((caught) => {
					error = caught;
				});
			await vi.advanceTimersByTimeAsync(6000);
			expect(error?.details?.status).toBe(status);
			await pending;
			expect(fetch_mock).toHaveBeenCalledTimes(2);
		},
	);
});
