import { ErrorType, ProviderError } from './types.js';

export const delay = (ms: number): Promise<void> => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};

export interface RetryOptions {
	max_retries?: number;
	initial_delay?: number;
	retry_if?: (error: unknown) => boolean;
}

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
	if (!(error instanceof ProviderError)) return true;

	if (is_non_retryable_provider_error(error)) {
		return false;
	}

	if (
		error.type === ErrorType.RATE_LIMIT ||
		error.type === ErrorType.PROVIDER_ERROR
	) {
		return true;
	}

	if (error.type === ErrorType.API_ERROR) {
		const status =
			error.details && typeof error.details === 'object'
				? (error.details as { status?: unknown }).status
				: undefined;
		if (typeof status !== 'number') return true;
		return (
			status === 408 ||
			status === 425 ||
			status === 429 ||
			status >= 500
		);
	}

	return false;
};

export const retry_with_backoff = async <T>(
	fn: () => Promise<T>,
	options_or_max_retries: number | RetryOptions = 3,
	legacy_initial_delay = 1000,
): Promise<T> => {
	const options: Required<RetryOptions> =
		typeof options_or_max_retries === 'number'
			? {
					max_retries: options_or_max_retries,
					initial_delay: legacy_initial_delay,
					retry_if: is_retryable_error,
				}
			: {
					max_retries: options_or_max_retries.max_retries ?? 3,
					initial_delay: options_or_max_retries.initial_delay ?? 1000,
					retry_if:
						options_or_max_retries.retry_if ?? is_retryable_error,
				};

	let retries = 0;
	while (true) {
		try {
			return await fn();
		} catch (error) {
			if (
				retries >= options.max_retries ||
				!options.retry_if(error)
			) {
				throw error;
			}
			const delay_time = options.initial_delay * Math.pow(2, retries);
			await delay(delay_time);
			retries++;
		}
	}
};
