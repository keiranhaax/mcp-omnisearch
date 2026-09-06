import { ErrorType, ProviderError } from './types.js';
import {
	combine_request_signal,
	run_with_request_context,
	throw_if_aborted,
	with_abort_signal,
} from './request_context.js';

export const delay = async (
	ms: number,
	signal?: AbortSignal,
): Promise<void> => {
	if (!Number.isFinite(ms) || ms < 0) {
		throw new RangeError('delay must be finite and non-negative');
	}
	// Node turns waits above this limit into 1ms timers. Chunk instead
	// of clamping: an upstream minimum delay must never become shorter.
	const max_timer_ms = 2_147_483_647;
	const combined_signal = combine_request_signal(signal);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		do {
			const chunk = Math.min(ms, max_timer_ms);
			await with_abort_signal(
				() =>
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, chunk);
					}),
				combined_signal,
			);
			ms -= chunk;
		} while (ms > 0);
	} finally {
		clearTimeout(timer);
	}
};

export interface RetryOptions {
	max_retries?: number;
	initial_delay?: number;
	retry_if?: (error: unknown) => boolean;
	signal?: AbortSignal;
	/** Total wall-clock budget across attempts and backoff, in ms. */
	timeout_ms?: number;
}

// Never turn an upstream Retry-After into an earlier paid retry.
const MAX_RETRY_WAIT_MS = 30_000;
const MAX_RETRIES = 5;

export const is_non_retryable_provider_error = (
	error: unknown,
): boolean => {
	if (!(error instanceof ProviderError)) return false;
	return (
		typeof error.details === 'object' &&
		error.details !== null &&
		(error.details as { retryable?: unknown }).retryable === false
	);
};

export const is_retryable_error = (error: unknown): boolean => {
	if (!(error instanceof ProviderError)) return false;

	if (is_non_retryable_provider_error(error)) {
		return false;
	}
	if (
		error.type === ErrorType.API_ERROR &&
		error.details?.retryable === true &&
		error.details?.cause === 'network'
	) {
		return true;
	}

	if (error.type === ErrorType.RATE_LIMIT) {
		return true;
	}

	if (
		error.type === ErrorType.API_ERROR ||
		error.type === ErrorType.PROVIDER_ERROR
	) {
		const status =
			error.details && typeof error.details === 'object'
				? (error.details as { status?: unknown }).status
				: undefined;
		if (typeof status !== 'number') {
			// Unknown provider errors are retryable only for PROVIDER_ERROR
			return error.type === ErrorType.PROVIDER_ERROR;
		}
		return (
			status === 408 ||
			status === 425 ||
			status === 429 ||
			status === 502 ||
			status === 503 ||
			status === 504
		);
	}

	return false;
};

export const retry_with_backoff = async <T>(
	fn: () => Promise<T>,
	options_or_max_retries: number | RetryOptions = 1,
	legacy_initial_delay = 250,
): Promise<T> => {
	const options =
		typeof options_or_max_retries === 'number'
			? {
					max_retries: options_or_max_retries,
					initial_delay: legacy_initial_delay,
					retry_if: is_retryable_error,
				}
			: {
					max_retries: options_or_max_retries.max_retries ?? 1,
					initial_delay: options_or_max_retries.initial_delay ?? 250,
					retry_if:
						options_or_max_retries.retry_if ?? is_retryable_error,
				};
	if (
		!Number.isInteger(options.max_retries) ||
		options.max_retries < 0 ||
		options.max_retries > MAX_RETRIES
	) {
		throw new RangeError(
			'max_retries must be an integer from 0 to 5',
		);
	}
	if (
		!Number.isFinite(options.initial_delay) ||
		options.initial_delay < 0
	) {
		throw new RangeError(
			'initial_delay must be finite and non-negative',
		);
	}
	const timeout_ms =
		typeof options_or_max_retries === 'number'
			? undefined
			: options_or_max_retries.timeout_ms;
	if (
		timeout_ms !== undefined &&
		(!Number.isSafeInteger(timeout_ms) ||
			timeout_ms < 1 ||
			timeout_ms > 2_147_483_647)
	) {
		throw new RangeError(
			'timeout_ms must be an integer from 1 to 2147483647',
		);
	}
	const timeout = new AbortController();
	const timer =
		timeout_ms === undefined
			? undefined
			: setTimeout(
					() =>
						timeout.abort(
							new DOMException('Operation timed out', 'TimeoutError'),
						),
					timeout_ms,
				);
	timer?.unref?.();
	const caller_signal = combine_request_signal(
		typeof options_or_max_retries === 'number'
			? undefined
			: options_or_max_retries.signal,
	);
	const signal =
		timeout_ms === undefined
			? caller_signal
			: caller_signal
				? AbortSignal.any([caller_signal, timeout.signal])
				: timeout.signal;

	let retries = 0;
	let wait_remaining = MAX_RETRY_WAIT_MS;
	try {
		while (true) {
			throw_if_aborted(signal);
			try {
				return await run_with_request_context(signal, () =>
					with_abort_signal(fn, signal),
				);
			} catch (error) {
				throw_if_aborted(signal);
				if (
					retries >= options.max_retries ||
					!options.retry_if(error)
				) {
					throw error;
				}
				// Full jitter: random delay in [0, exponential backoff]
				const ceiling = options.initial_delay * Math.pow(2, retries);
				const reset_time =
					error instanceof ProviderError
						? error.details?.reset_time
						: undefined;
				const retry_after =
					reset_time instanceof Date &&
					Number.isFinite(reset_time.getTime())
						? Math.max(0, reset_time.getTime() - Date.now())
						: 0;
				const wait = Math.max(retry_after, Math.random() * ceiling);
				if (wait > wait_remaining) throw error;
				wait_remaining -= wait;
				await delay(wait, signal);
				retries++;
			}
		}
	} finally {
		clearTimeout(timer);
	}
};
