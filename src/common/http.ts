import { handle_rate_limit } from './errors.js';
import { ErrorType, ProviderError } from './types.js';

export interface HttpJsonOptions extends RequestInit {
	expectedStatuses?: number[];
}

const tryParseJson = (text: string) => {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const entitlement_pattern =
	/(does not have access|not authorized|forbidden|entitlement|requires?.*plan|upgrade|subscription|insufficient permissions|option.not.in.plan|not.subscribed)/i;
const endpoint_missing_pattern =
	/(cannot (get|post|put|patch|delete)\s+\/|endpoint not found|route not found|unknown endpoint)/i;

export const safe_endpoint = (url: string): string => {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url.split('?')[0];
	}
};

export const http_json = async <T = any>(
	provider: string,
	url: string,
	options: HttpJsonOptions = {},
): Promise<T> => {
	const res = await fetch(url, options);
	const raw = await res.text();
	const body = tryParseJson(raw);

	const okOrExpected =
		res.ok ||
		(options.expectedStatuses &&
			options.expectedStatuses.includes(res.status));

	if (!okOrExpected) {
		const raw_message =
			(body &&
				(body.message ||
					body.detail ||
					(typeof body.error === 'string'
						? body.error
						: body.error?.detail || body.error?.message) ||
					(body.error?.code
						? `${body.error.code}: ${body.error.detail || ''}`
						: undefined))) ||
			raw ||
			res.statusText;
		const message =
			typeof raw_message === 'string'
				? raw_message
				: JSON.stringify(raw_message);
		const details = {
			status: res.status,
			url: safe_endpoint(url),
			method: (options.method || 'GET').toUpperCase(),
			response: message,
		};

		switch (res.status) {
			case 401:
				throw new ProviderError(
					ErrorType.API_ERROR,
					'Invalid API key',
					provider,
					details,
				);
			case 403:
				throw new ProviderError(
					ErrorType.ENTITLEMENT_REQUIRED,
					'API key does not have access to this endpoint',
					provider,
					details,
				);
			case 429:
				handle_rate_limit(provider);
			default:
				if (
					res.status === 404 &&
					endpoint_missing_pattern.test(message)
				) {
					throw new ProviderError(
						ErrorType.ENDPOINT_NOT_FOUND,
						'Endpoint not found',
						provider,
						details,
					);
				}
				if (entitlement_pattern.test(message)) {
					throw new ProviderError(
						ErrorType.ENTITLEMENT_REQUIRED,
						'API key does not have access to this endpoint',
						provider,
						details,
					);
				}
				if (res.status >= 500) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						`${provider} API internal error`,
						provider,
						details,
					);
				}
				throw new ProviderError(
					ErrorType.API_ERROR,
					`Unexpected error: ${message}`,
					provider,
					details,
				);
		}
	}

	// Prefer JSON if parseable, otherwise return as any
	return (body as T) ?? (raw as unknown as T);
};
