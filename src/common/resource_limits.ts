import { performance } from 'node:perf_hooks';
import { throw_if_aborted } from './request_context.js';
import { ErrorType, ProviderError } from './types.js';

export const PROVIDER_CONCURRENCY = 4;
export const PROVIDER_QUEUE_LIMIT = 32;
const MAX_PROVIDER_KEYS = 64;
interface Waiter {
	resolve: () => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	on_abort: () => void;
}
interface ProviderLoad {
	active: number;
	queue: Waiter[];
	completed: number;
	failed: number;
	rejected: number;
	total_duration_ms: number;
}
const providers = new Map<string, ProviderLoad>();
const provider_family = (name: string) => {
	for (const family of ['firecrawl', 'brave', 'tavily', 'exa']) {
		if (name === family || name.startsWith(`${family}_`))
			return family;
	}
	return name;
};
const busy = (provider: string) =>
	new ProviderError(
		ErrorType.RATE_LIMIT,
		'Provider concurrency limit reached',
		provider,
		{ retryable: false },
	);

const acquire = async (
	provider: string,
	signal?: AbortSignal,
): Promise<ProviderLoad> => {
	throw_if_aborted(signal);
	let state = providers.get(provider);
	if (!state) {
		if (providers.size >= MAX_PROVIDER_KEYS) throw busy(provider);
		state = {
			active: 0,
			queue: [],
			completed: 0,
			failed: 0,
			rejected: 0,
			total_duration_ms: 0,
		};
		providers.set(provider, state);
	}
	if (state.active < PROVIDER_CONCURRENCY) {
		state.active++;
		return state;
	}
	if (state.queue.length >= PROVIDER_QUEUE_LIMIT) {
		state.rejected++;
		throw busy(provider);
	}
	const load = state;
	await new Promise<void>((resolve, reject) => {
		const waiter: Waiter = {
			resolve,
			reject,
			signal,
			on_abort: () => {
				const index = load.queue.indexOf(waiter);
				if (index < 0) return;
				load.queue.splice(index, 1);
				try {
					throw_if_aborted(signal);
				} catch (error) {
					reject(error);
				}
			},
		};
		load.queue.push(waiter);
		signal?.addEventListener('abort', waiter.on_abort, {
			once: true,
		});
	});
	return load;
};
const release = (state: ProviderLoad) => {
	const next = state.queue.shift();
	if (next) {
		next.signal?.removeEventListener('abort', next.on_abort);
		next.resolve();
	} else state.active--;
};

export const with_provider_slot = async <T>(
	provider: string,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> => {
	const state = await acquire(provider_family(provider), signal);
	const started = performance.now();
	try {
		throw_if_aborted(signal);
		const result = await fn();
		state.completed++;
		return result;
	} catch (error) {
		state.failed++;
		throw error;
	} finally {
		state.total_duration_ms += performance.now() - started;
		release(state);
	}
};

export const get_resource_snapshot = () => ({
	provider_concurrency: PROVIDER_CONCURRENCY,
	provider_queue_limit: PROVIDER_QUEUE_LIMIT,
	providers: Object.fromEntries(
		[...providers].map(([name, state]) => [
			name,
			{
				active: state.active,
				queued: state.queue.length,
				completed: state.completed,
				failed: state.failed,
				rejected: state.rejected,
				total_duration_ms: Math.round(state.total_duration_ms),
			},
		]),
	),
});
