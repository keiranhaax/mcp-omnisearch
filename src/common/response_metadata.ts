import type { JobMetadata } from './job_state.js';

export interface ProviderResponseMetadata {
	request_id?: string;
	response_time_seconds?: number;
	usage?: { credits: number } | { usd: number };
	job?: JobMetadata;
}

const response_metadata = new WeakMap<
	object,
	ProviderResponseMetadata
>();

const is_record = (
	value: unknown,
): value is Record<string, unknown> =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value);

const is_measurement = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const set_response_metadata = (
	result: object,
	raw: unknown,
	provider = 'tavily',
): void => {
	if (!is_record(raw)) return;
	const metadata: ProviderResponseMetadata = {
		...response_metadata.get(result),
	};
	const request_id = provider.startsWith('exa')
		? raw.requestId
		: raw.request_id;
	if (
		typeof request_id === 'string' &&
		/^[A-Za-z0-9_-]{1,128}$/.test(request_id)
	) {
		metadata.request_id = request_id;
	}
	if (is_measurement(raw.response_time)) {
		metadata.response_time_seconds = raw.response_time;
	}
	if (
		provider === 'firecrawl_agent' &&
		is_measurement(raw.creditsUsed)
	) {
		metadata.usage = { credits: raw.creditsUsed };
	} else if (
		provider.startsWith('exa') &&
		is_record(raw.costDollars) &&
		is_measurement(raw.costDollars.total)
	) {
		metadata.usage = { usd: raw.costDollars.total };
	} else if (
		provider.startsWith('tavily') &&
		is_record(raw.usage) &&
		is_measurement(raw.usage.credits)
	) {
		metadata.usage = { credits: raw.usage.credits };
	}
	if (Object.keys(metadata).length > 0) {
		response_metadata.set(result, metadata);
	}
};

export const get_response_metadata = (
	result: object,
): ProviderResponseMetadata | undefined =>
	response_metadata.get(result);

export const set_response_job = (
	result: object,
	job: JobMetadata,
): void => {
	response_metadata.set(result, {
		...response_metadata.get(result),
		job,
	});
};

export const copy_response_metadata = (
	from: object,
	to: object,
): void => {
	const metadata = response_metadata.get(from);
	if (metadata) response_metadata.set(to, { ...metadata });
};

export const request_metadata = (
	result: unknown,
	provider: string,
	operation: string,
	elapsed_ms: number,
) => {
	const reported =
		result && typeof result === 'object'
			? get_response_metadata(result)
			: undefined;
	return {
		provider,
		operation,
		elapsed_ms:
			Number.isFinite(elapsed_ms) && elapsed_ms >= 0
				? elapsed_ms
				: null,
		...reported,
		usage: reported?.usage ?? null,
		usage_source: reported?.usage ? 'provider_reported' : 'unknown',
		usage_scope: reported?.usage
			? reported.job
				? 'job'
				: 'request'
			: 'unknown',
	};
};
