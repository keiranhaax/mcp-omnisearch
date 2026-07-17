import { http_json } from './http.js';
import { ErrorType, ProviderError } from './types.js';
import { validate_api_key } from './validation.js';
import { config } from '../config/env.js';

export type ContextDevParams = Record<string, unknown>;

const append_param = (params: URLSearchParams, key: string, value: unknown) => {
	if (value === undefined || value === null) return;
	if (Array.isArray(value)) {
		for (const item of value) append_param(params, key, item);
		return;
	}
	params.append(key, String(value));
};

const context_api_key = () =>
	validate_api_key(config.search.context_dev.api_key, 'context_dev');

const context_url = (path: string, params?: ContextDevParams) => {
	const url = new URL(`${config.search.context_dev.base_url}${path}`);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			append_param(url.searchParams, key, value);
		}
	}
	return url.toString();
};

export const context_dev_get = async <T>(
	path: string,
	params?: ContextDevParams,
): Promise<T> => {
	const api_key = context_api_key();
	return http_json<T>('context_dev', context_url(path, params), {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${api_key}`,
			Accept: 'application/json',
		},
		signal: AbortSignal.timeout(config.search.context_dev.timeout),
	});
};

export const context_dev_post = async <T>(
	path: string,
	body: ContextDevParams,
): Promise<T> => {
	const api_key = context_api_key();
	return http_json<T>('context_dev', context_url(path), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${api_key}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(config.search.context_dev.timeout),
	});
};

export const require_one = (
	provider: string,
	fields: Record<string, unknown>,
) => {
	const present = Object.entries(fields).filter(([, value]) => {
		return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
	});
	if (present.length !== 1) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			`Provide exactly one of: ${Object.keys(fields).join(', ')}`,
			provider,
		);
	}
};
