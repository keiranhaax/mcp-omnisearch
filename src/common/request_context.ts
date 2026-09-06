import { AsyncLocalStorage } from 'node:async_hooks';

const request_context = new AsyncLocalStorage<{
	signal: AbortSignal | undefined;
}>();

export const run_with_request_context = <T>(
	signal: AbortSignal | undefined,
	fn: () => T,
): T => request_context.run({ signal }, fn);

export const get_request_signal = (): AbortSignal | undefined =>
	request_context.getStore()?.signal;

export const combine_request_signal = (
	signal?: AbortSignal | null,
): AbortSignal | undefined => {
	const request_signal = get_request_signal();
	if (!signal) return request_signal;
	if (!request_signal || request_signal === signal) return signal;
	return AbortSignal.any([request_signal, signal]);
};

const abort_error = (signal: AbortSignal) => {
	const timed_out =
		signal.reason instanceof Error &&
		signal.reason.name === 'TimeoutError';
	return new DOMException(
		timed_out ? 'Operation timed out' : 'Operation cancelled',
		timed_out ? 'TimeoutError' : 'AbortError',
	);
};

export const throw_if_aborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw abort_error(signal);
};

// Race even non-cooperative adapters, and always release listeners.
export const with_abort_signal = async <T>(
	fn: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> => {
	throw_if_aborted(signal);
	if (!signal) return fn();
	let on_abort: () => void = () => {};
	try {
		return await new Promise<T>((resolve, reject) => {
			on_abort = () => reject(abort_error(signal));
			signal.addEventListener('abort', on_abort, { once: true });
			fn().then(resolve, reject);
		});
	} finally {
		signal.removeEventListener('abort', on_abort);
	}
};
