import * as v from 'valibot';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

vi.mock('./http.js', () => ({
	http_json: vi.fn(),
}));

import {
	make_firecrawl_request,
	poll_firecrawl_job,
	validate_firecrawl_response,
} from './firecrawl_utils.js';
import { http_json } from './http.js';
import { ErrorType, ProviderError } from './types.js';
import { run_with_request_context } from './request_context.js';

const http_json_mock = vi.mocked(http_json);

const firecrawl_job_schema = v.object({
	success: v.optional(v.boolean()),
	status: v.optional(
		v.picklist([
			'scraping',
			'processing',
			'completed',
			'failed',
			'cancelled',
			'error',
		]),
	),
	id: v.optional(v.string()),
	data: v.optional(v.unknown()),
	error: v.optional(v.string()),
});

describe('make_firecrawl_request', () => {
	beforeEach(() => {
		http_json_mock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sends a POST request with bearer auth and JSON body', async () => {
		http_json_mock.mockResolvedValue({ success: true, id: 'job-1' });

		await expect(
			make_firecrawl_request(
				'firecrawl',
				'https://api.firecrawl.dev/v2/scrape',
				'secret-key',
				{ url: 'https://example.com' },
				5000,
				firecrawl_job_schema,
			),
		).resolves.toEqual({ success: true, id: 'job-1' });

		expect(http_json_mock).toHaveBeenCalledWith(
			'firecrawl',
			'https://api.firecrawl.dev/v2/scrape',
			expect.objectContaining({
				method: 'POST',
				headers: {
					Authorization: 'Bearer secret-key',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ url: 'https://example.com' }),
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it('rejects malformed envelopes without exposing response values', async () => {
		const secret = 'response-secret-must-not-leak';
		http_json_mock.mockResolvedValue({
			success: { api_key: secret },
		});

		let thrown: unknown;
		try {
			await make_firecrawl_request(
				'firecrawl',
				'https://api.firecrawl.dev/v2/scrape',
				'secret-key',
				{ url: 'https://example.com' },
				5000,
				firecrawl_job_schema,
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl',
			message: 'Malformed firecrawl response',
			details: { retryable: false },
		});
		expect(JSON.stringify(thrown)).not.toContain(secret);
	});
});

describe('validate_firecrawl_response', () => {
	it('accepts successful responses without an error field', () => {
		expect(() =>
			validate_firecrawl_response(
				{ success: true },
				'firecrawl',
				'Scrape failed',
			),
		).not.toThrow();
	});

	it('throws when the response is unsuccessful', () => {
		expect(() =>
			validate_firecrawl_response(
				{ success: false, error: 'invalid URL' },
				'firecrawl',
				'Scrape failed',
			),
		).toThrowError(
			expect.objectContaining({
				type: ErrorType.PROVIDER_ERROR,
				provider: 'firecrawl',
				message: 'Scrape failed',
			}),
		);
	});
});

describe('poll_firecrawl_job', () => {
	beforeEach(() => {
		http_json_mock.mockReset();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each([401, 403, 404])(
		'stops permanent HTTP %s without losing the error',
		async (status) => {
			const error = new ProviderError(
				ErrorType.API_ERROR,
				'permanent',
				'firecrawl',
				{ status },
			);
			http_json_mock.mockRejectedValue(error);
			const result = poll_firecrawl_job(
				{
					provider_name: 'firecrawl',
					status_url: 'https://api.firecrawl.dev/v2/jobs/123',
					api_key: 'test-key',
					max_attempts: 3,
					poll_interval: 10,
					timeout: 5000,
				},
				firecrawl_job_schema,
			).catch((error) => error);
			await vi.advanceTimersByTimeAsync(30);
			expect(await result).toBe(error);
			expect(http_json_mock).toHaveBeenCalledTimes(1);
		},
	);

	it('cancels polling during the sleep without making a GET', async () => {
		const controller = new AbortController();
		let settled = false;
		const result = run_with_request_context(controller.signal, () =>
			poll_firecrawl_job(
				{
					provider_name: 'firecrawl',
					status_url: 'https://api.firecrawl.dev/v2/jobs/123',
					api_key: 'test-key',
					max_attempts: 3,
					poll_interval: 1000,
					timeout: 5000,
				},
				firecrawl_job_schema,
			),
		).catch((error) => {
			settled = true;
			return error;
		});
		controller.abort();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBe(true);
		expect(await result).toMatchObject({ name: 'AbortError' });
		expect(http_json_mock).not.toHaveBeenCalled();
	});

	it('enforces one total deadline including an in-flight poll', async () => {
		http_json_mock.mockImplementation(() => new Promise(() => {}));
		let settled = false;
		const result = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'test-key',
				max_attempts: 3,
				poll_interval: 10,
				timeout: 25,
			},
			firecrawl_job_schema,
		).catch((error) => {
			settled = true;
			return error;
		});
		await vi.advanceTimersByTimeAsync(25);
		expect(settled).toBe(true);
		expect(await result).toMatchObject({ name: 'TimeoutError' });
		expect(http_json_mock).toHaveBeenCalledTimes(1);
		expect(http_json_mock.mock.calls[0][2]?.signal?.aborted).toBe(
			true,
		);
	});

	it('honors Retry-After before issuing another status request', async () => {
		http_json_mock
			.mockRejectedValueOnce(
				new ProviderError(
					ErrorType.RATE_LIMIT,
					'rate limited',
					'firecrawl',
					{ reset_time: new Date(Date.now() + 1000) },
				),
			)
			.mockResolvedValue({ status: 'completed' });
		const result = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'test-key',
				max_attempts: 2,
				poll_interval: 10,
				timeout: 2000,
			},
			firecrawl_job_schema,
		);
		await vi.advanceTimersByTimeAsync(999);
		expect(http_json_mock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(http_json_mock).toHaveBeenCalledTimes(2);
	});

	it('retries through transient polling failures and resolves on completion', async () => {
		http_json_mock
			.mockRejectedValueOnce(new Error('temporary network issue'))
			.mockResolvedValueOnce({
				success: true,
				status: 'processing',
			})
			.mockResolvedValueOnce({
				success: true,
				status: 'completed',
				data: { pages: 3 },
			});

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 3,
				poll_interval: 10,
				timeout: 5000,
			},
			firecrawl_job_schema,
		);

		await vi.advanceTimersByTimeAsync(30);

		await expect(promise).resolves.toEqual({
			success: true,
			status: 'completed',
			data: { pages: 3 },
		});
		expect(http_json_mock).toHaveBeenCalledTimes(3);
	});

	it('accepts current completed job responses that omit success', async () => {
		http_json_mock.mockResolvedValue({
			status: 'completed',
			data: { pages: 1 },
		});

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 1,
				poll_interval: 10,
				timeout: 5000,
			},
			firecrawl_job_schema,
		);
		const resolution = expect(promise).resolves.toMatchObject({
			status: 'completed',
			data: { pages: 1 },
		});

		await vi.advanceTimersByTimeAsync(10);
		await resolution;
	});

	it('throws when the polled job reports an error status', async () => {
		http_json_mock.mockResolvedValue({
			success: true,
			status: 'error',
			error: 'crawl crashed',
		});

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 1,
				poll_interval: 10,
				timeout: 5000,
			},
			firecrawl_job_schema,
		);
		const rejection = expect(promise).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl',
			message: 'Job failed: error',
		});

		await vi.advanceTimersByTimeAsync(10);
		await rejection;
	});

	it.each(['failed', 'cancelled'])(
		'throws when the polled job reports %s',
		async (status) => {
			http_json_mock.mockResolvedValue({
				status,
				error: `${status} job`,
			});

			const promise = poll_firecrawl_job(
				{
					provider_name: 'firecrawl',
					status_url: 'https://api.firecrawl.dev/v2/jobs/123',
					api_key: 'secret-key',
					max_attempts: 1,
					poll_interval: 10,
					timeout: 5000,
				},
				firecrawl_job_schema,
			);
			const rejection = expect(promise).rejects.toMatchObject({
				type: ErrorType.PROVIDER_ERROR,
				message: `Job failed: ${status}`,
			});

			await vi.advanceTimersByTimeAsync(10);
			await rejection;
		},
	);

	it('rejects a malformed status envelope without polling again', async () => {
		const sentinel = 'polling-payload-secret-must-not-leak';
		http_json_mock.mockResolvedValue({
			status: { unexpected: sentinel },
		});

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 3,
				poll_interval: 10,
				timeout: 5000,
			},
			firecrawl_job_schema,
		);
		const rejection = promise.catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(10);
		const thrown = await rejection;
		expect(thrown).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl',
			message: 'Malformed firecrawl response',
			details: { retryable: false },
		});
		expect(JSON.stringify(thrown)).not.toContain(sentinel);
		expect(http_json_mock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ label: 'empty', response: {} },
		{ label: 'success-only', response: { success: true } },
	])(
		'rejects a $label polling response with no status immediately',
		async ({ response }) => {
			http_json_mock.mockResolvedValue(response);

			const promise = poll_firecrawl_job(
				{
					provider_name: 'firecrawl',
					status_url: 'https://api.firecrawl.dev/v2/jobs/123',
					api_key: 'secret-key',
					max_attempts: 3,
					poll_interval: 10,
					timeout: 5000,
				},
				firecrawl_job_schema,
			);
			const rejection = promise.catch((error: unknown) => error);

			await vi.advanceTimersByTimeAsync(10);
			const thrown = await rejection;

			expect(thrown).toMatchObject({
				type: ErrorType.PROVIDER_ERROR,
				provider: 'firecrawl',
				message: 'Malformed firecrawl response',
				details: { retryable: false },
			});
			expect(http_json_mock).toHaveBeenCalledTimes(1);
		},
	);

	it('includes the polling status when the caller schema omits it', async () => {
		http_json_mock.mockResolvedValue({
			status: 'completed',
			data: { pages: 1 },
		});

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 1,
				poll_interval: 10,
				timeout: 5000,
			},
			v.object({ data: v.optional(v.unknown()) }),
		);
		const resolution = expect(promise).resolves.toEqual({
			status: 'completed',
			data: { pages: 1 },
		});

		await vi.advanceTimersByTimeAsync(10);
		await resolution;
	});

	it('returns the last pending status on exhaustion when return_on_exhaustion is set', async () => {
		http_json_mock
			.mockResolvedValueOnce({
				success: true,
				status: 'scraping',
			})
			.mockResolvedValueOnce({
				success: true,
				status: 'processing',
			});

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 2,
				poll_interval: 10,
				timeout: 5000,
				return_on_exhaustion: true,
			},
			firecrawl_job_schema,
		);
		const resolution = expect(promise).resolves.toMatchObject({
			success: true,
			status: 'processing',
		});

		await vi.advanceTimersByTimeAsync(20);
		await resolution;
		expect(http_json_mock).toHaveBeenCalledTimes(2);
	});

	it('still times out with return_on_exhaustion when every poll fails transiently', async () => {
		http_json_mock.mockRejectedValue(
			new Error('temporary network issue'),
		);

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 3,
				poll_interval: 10,
				timeout: 5000,
				return_on_exhaustion: true,
			},
			firecrawl_job_schema,
		);
		const rejection = expect(promise).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl',
			message:
				'Job timed out - try again later or with a smaller scope',
		});

		await vi.advanceTimersByTimeAsync(30);
		await rejection;
		expect(http_json_mock).toHaveBeenCalledTimes(3);
	});

	it('times out when every poll fails transiently', async () => {
		http_json_mock.mockRejectedValue(
			new Error('temporary network issue'),
		);

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 3,
				poll_interval: 10,
				timeout: 5000,
			},
			firecrawl_job_schema,
		);
		const rejection = expect(promise).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl',
			message:
				'Job timed out - try again later or with a smaller scope',
		});

		await vi.advanceTimersByTimeAsync(30);
		await rejection;
		expect(http_json_mock).toHaveBeenCalledTimes(3);
	});

	it('times out after the configured number of attempts', async () => {
		http_json_mock.mockResolvedValue({
			success: true,
			status: 'processing',
		});

		const promise = poll_firecrawl_job(
			{
				provider_name: 'firecrawl',
				status_url: 'https://api.firecrawl.dev/v2/jobs/123',
				api_key: 'secret-key',
				max_attempts: 2,
				poll_interval: 10,
				timeout: 5000,
			},
			firecrawl_job_schema,
		);
		const rejection = expect(promise).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl',
			message:
				'Job timed out - try again later or with a smaller scope',
		});

		await vi.advanceTimersByTimeAsync(20);
		await rejection;
	});
});
