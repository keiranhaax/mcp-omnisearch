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
			name: 'AbortError',
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
			fetch_mock.mockImplementation(() => {
				if (phase === 'start request') return new Promise(() => {});
				const response = json_response({
					status: 'pending',
					request_id: 'job-1',
				});
				if (phase === 'response body')
					vi.spyOn(response, 'text').mockReturnValue(
						new Promise(() => {}),
					);
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
			expect(settled).toBe(true);
			await pending;
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
