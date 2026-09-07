import { ProviderError } from './types.js';

export type JobState =
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'unknown';
export interface JobMetadata {
	id: string;
	state: JobState;
	provider_status?: string;
	partial: boolean;
	resumable: boolean;
	cancellation?: 'confirmed' | 'unconfirmed';
	wait_interrupted?: 'timeout' | 'cancelled';
}

// Provider-specific status allowlists, not exception-message heuristics.
export const job_metadata = (
	provider: 'tavily_research' | 'firecrawl_agent',
	id: string,
	raw_status: unknown,
	partial: boolean,
): JobMetadata => {
	const status =
		typeof raw_status === 'string' &&
		/^[a-z_]{1,64}$/.test(raw_status)
			? raw_status
			: undefined;
	let state: JobState = 'unknown';
	if (status === 'completed') state = 'completed';
	else if (status === 'failed' || status === 'error')
		state = 'failed';
	else if (provider === 'tavily_research') {
		if (status === 'pending') state = 'queued';
		if (status === 'in_progress') state = 'running';
	} else {
		if (status === 'queued') state = 'queued';
		if (status === 'scraping' || status === 'processing')
			state = 'running';
		if (status === 'cancelled') state = 'cancelled';
	}
	return {
		id,
		state,
		...(status ? { provider_status: status } : {}),
		partial,
		resumable: ['queued', 'running', 'unknown'].includes(state),
		...(state === 'cancelled'
			? { cancellation: 'confirmed' as const }
			: {}),
	};
};

interface JobFailure {
	job: JobMetadata;
	result?: unknown;
}
// Evidence never enters error.details, logs, or generic error serialization.
const failures = new WeakMap<ProviderError, JobFailure>();
export const set_job_failure = (
	error: ProviderError,
	job: JobMetadata,
	result?: unknown,
): ProviderError => {
	failures.set(error, {
		job,
		...(result !== undefined ? { result } : {}),
	});
	return error;
};
export const get_job_failure = (
	error: unknown,
): JobFailure | undefined =>
	error instanceof ProviderError ? failures.get(error) : undefined;
