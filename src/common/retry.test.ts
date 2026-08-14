import { afterEach, describe, expect, it, vi } from 'vitest';
import { retry_with_backoff } from './retry.js';
import { ErrorType, ProviderError } from './types.js';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('retry_with_backoff', () => {
	it('returns immediately when the operation succeeds on the first try', async () => {
		const fn = vi.fn().mockResolvedValue('ok');

		await expect(retry_with_backoff(fn)).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retries transient errors with exponential backoff', async () => {
		vi.useFakeTimers();
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('first failure'))
			.mockRejectedValueOnce(
				new ProviderError(
					ErrorType.PROVIDER_ERROR,
					'transient provider failure',
					'test',
				),
			)
			.mockResolvedValueOnce('ok');

		const promise = retry_with_backoff(fn, 3, 100);
		const resolution = expect(promise).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(fn).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(200);
		expect(fn).toHaveBeenCalledTimes(3);
		await resolution;
	});

	it('rethrows the final retryable error after exhausting retries', async () => {
		vi.useFakeTimers();
		const error = new Error('still failing');
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
