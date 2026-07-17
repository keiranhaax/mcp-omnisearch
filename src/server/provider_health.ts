import { ErrorType, ProviderError } from '../common/types.js';

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
	last_endpoint?: string;
	last_success_at?: string;
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

export const mark_provider_success = (
	category: ProviderCategory,
	provider: string,
) => {
	const state = ensure_state(category, provider);
	state.last_runtime_status = 'ok';
	state.active_error = false;
	state.last_success_at = new Date().toISOString();
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
) => {
	if (!(error instanceof ProviderError)) return;
	if (error.type === ErrorType.INVALID_INPUT) return;

	const state = ensure_state(category, provider);
	state.last_runtime_status = map_error_to_status(error);
	state.active_error = true;
	state.last_error = error.message;
	state.last_error_type = error.type;
	state.last_error_at = new Date().toISOString();
	if (
		error.details &&
		typeof error.details === 'object' &&
		typeof error.details.url === 'string'
	) {
		state.last_endpoint = error.details.url;
	}

	console.warn(
		`Provider runtime issue (${category}/${provider}): ${state.last_runtime_status} - ${error.message}`,
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
): ProviderHealthState => ({
	...state,
	active_error:
		get_effective_runtime_status(state) !== 'ok' &&
		state.last_runtime_status !== 'unknown',
});

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
};
