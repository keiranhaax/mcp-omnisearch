import { ErrorType, ProviderError } from '../common/types.js';
import {
	public_error_message,
	public_error_metadata,
	safe_endpoint,
	type PublicErrorKind,
} from '../common/errors.js';
import {
	record_provider_outcome,
	reset_provider_metrics,
	type ProviderUsage,
} from './provider_metrics.js';
import {
	get_provider_cooldown,
	note_provider_failure,
	reset_provider_cooldowns,
} from './provider_cooldown.js';
import { record_spend } from './spend_caps.js';

export type ProviderCategory =
	| 'search'
	| 'ai_response'
	| 'processing';

export type ProviderRuntimeStatus =
	| 'unknown'
	| 'ok'
	| 'entitlement_required'
	| 'endpoint_missing'
	| 'provider_error';

export interface ProviderHealthState {
	category: ProviderCategory;
	provider: string;
	registered: boolean;
	last_runtime_status: ProviderRuntimeStatus;
	active_error?: boolean;
	last_error_at?: string;
	last_error?: string;
	last_error_type?: string;
	last_error_kind?: PublicErrorKind;
	last_endpoint?: string;
	last_success_at?: string;
	/** Present only while new paid work for the provider is refused. */
	cooldown_until?: string;
	cooldown_status?: number;
}

const health_state = new Map<string, ProviderHealthState>();

const make_key = (category: ProviderCategory, provider: string) =>
	`${category}:${provider}`;

const ensure_state = (
	category: ProviderCategory,
	provider: string,
): ProviderHealthState => {
	const key = make_key(category, provider);
	const existing = health_state.get(key);
	if (existing) return existing;

	const created: ProviderHealthState = {
		category,
		provider,
		registered: true,
		last_runtime_status: 'unknown',
	};
	health_state.set(key, created);
	return created;
};

export const register_provider = (
	category: ProviderCategory,
	provider: string,
) => {
	const state = ensure_state(category, provider);
	state.registered = true;
};

/** Optional per-call facts recorded into the metrics counters. */
export interface ProviderCallOutcome {
	tool?: string;
	elapsed_ms?: number | null;
	usage?: ProviderUsage | null;
	/** The result was replayed from the HTTP cache. */
	cached?: boolean;
	/** Usage is cumulative for this job; only increments are spend. */
	job_id?: string;
}

export const mark_provider_success = (
	category: ProviderCategory,
	provider: string,
	outcome: ProviderCallOutcome = {},
) => {
	const state = ensure_state(category, provider);
	state.last_runtime_status = 'ok';
	state.active_error = false;
	state.last_success_at = new Date().toISOString();
	delete state.last_error;
	delete state.last_error_at;
	delete state.last_error_type;
	delete state.last_error_kind;
	delete state.last_endpoint;
	record_provider_outcome({
		category,
		provider,
		tool: outcome.tool,
		ok: true,
		elapsed_ms: outcome.elapsed_ms ?? undefined,
		usage: outcome.cached ? null : outcome.usage,
		cached: outcome.cached === true,
	});
	if (!outcome.cached && outcome.usage)
		record_spend(provider, outcome.usage, { job_id: outcome.job_id });
};

const map_error_to_status = (
	error: ProviderError,
): ProviderRuntimeStatus => {
	if (error.type === ErrorType.ENTITLEMENT_REQUIRED) {
		return 'entitlement_required';
	}
	if (error.type === ErrorType.ENDPOINT_NOT_FOUND) {
		return 'endpoint_missing';
	}
	return 'provider_error';
};

export const mark_provider_error = (
	category: ProviderCategory,
	provider: string,
	error: unknown,
	outcome: ProviderCallOutcome = {},
) => {
	if (error instanceof Error && error.name === 'TimeoutError') {
		error = new ProviderError(
			ErrorType.API_ERROR,
			'Operation timed out',
			provider,
			{ retryable: false, cause: 'timeout' },
		);
	}
	// Every failed call counts in the metrics, including validation and
	// cancellation; only genuine provider faults change health below.
	record_provider_outcome({
		category,
		provider,
		tool: outcome.tool,
		ok: false,
		elapsed_ms: outcome.elapsed_ms ?? undefined,
		kind: public_error_metadata(error).kind,
	});
	if (!(error instanceof ProviderError)) return;
	// A rate limit or 5xx that survived the retries opens a cooldown;
	// the classifier ignores policy refusals, so this cannot self-feed.
	note_provider_failure(category, provider, error);
	const { kind } = public_error_metadata(error);
	if (
		kind === 'cancelled' ||
		kind === 'storage_failure' ||
		kind === 'spend_cap' ||
		kind === 'provider_cooldown'
	)
		return;
	if (error.type === ErrorType.INVALID_INPUT) return;

	const state = ensure_state(category, provider);
	state.last_runtime_status = map_error_to_status(error);
	state.active_error = true;
	state.last_error = public_error_message(error);
	state.last_error_type = error.type;
	state.last_error_kind = kind;
	state.last_error_at = new Date().toISOString();
	delete state.last_endpoint;
	if (
		error.details &&
		typeof error.details === 'object' &&
		typeof error.details.url === 'string'
	) {
		state.last_endpoint = safe_endpoint(error.details.url);
	}

	console.warn(
		`Provider runtime issue (${category}/${provider}): ${state.last_runtime_status} - ${state.last_error}`,
	);
};

const is_success_newer_than_error = (state: ProviderHealthState) =>
	state.last_success_at !== undefined &&
	state.last_error_at !== undefined &&
	state.last_success_at > state.last_error_at;

const get_effective_runtime_status = (
	state: ProviderHealthState,
): ProviderRuntimeStatus => {
	if (state.last_runtime_status === 'unknown') return 'unknown';
	if (
		state.last_runtime_status === 'ok' ||
		is_success_newer_than_error(state)
	) {
		return 'ok';
	}
	return state.last_runtime_status;
};

const decorate_state = (
	state: ProviderHealthState,
): ProviderHealthState => {
	const cooldown = get_provider_cooldown(
		state.category,
		state.provider,
	);
	return {
		...state,
		active_error:
			get_effective_runtime_status(state) !== 'ok' &&
			state.last_runtime_status !== 'unknown',
		...(cooldown
			? {
					cooldown_until: cooldown.until.toISOString(),
					...(cooldown.status !== undefined
						? { cooldown_status: cooldown.status }
						: {}),
				}
			: {}),
	};
};

export const get_provider_health_snapshot = () => {
	const by_category: Record<
		ProviderCategory,
		Record<string, ProviderHealthState>
	> = {
		search: {},
		ai_response: {},
		processing: {},
	};

	for (const state of health_state.values()) {
		by_category[state.category][state.provider] =
			decorate_state(state);
	}

	return by_category;
};

export const get_provider_health_summary = () => {
	let ok = 0;
	let unknown = 0;
	let degraded = 0;

	for (const state of health_state.values()) {
		const effective_status = get_effective_runtime_status(state);
		if (effective_status === 'ok') ok++;
		else if (effective_status === 'unknown') unknown++;
		else degraded++;
	}

	return {
		ok,
		unknown,
		degraded,
		total: health_state.size,
	};
};

export const reset_provider_health = () => {
	health_state.clear();
	reset_provider_metrics();
	reset_provider_cooldowns();
};
