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
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await with_abort_signal(
			() =>
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, ms);
				}),
			combine_request_signal(signal),
		);
	} finally {
		clearTimeout(timer);
	}
};

export interface RetryOptions {
	max_retries?: number;
	initial_delay?: number;
	retry_if?: (error: unknown) => boolean;
	signal?: AbortSignal;
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
	const signal = combine_request_signal(
		typeof options_or_max_retries === 'number'
			? undefined
			: options_or_max_retries.signal,
	);

	let retries = 0;
	let wait_remaining = MAX_RETRY_WAIT_MS;
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
};
