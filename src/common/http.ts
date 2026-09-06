import { handle_rate_limit, safe_endpoint } from './errors.js';
export { safe_endpoint } from './errors.js';
import {
	combine_request_signal,
	consume_response_bytes,
	throw_if_aborted,
	with_abort_signal,
} from './request_context.js';
import { with_provider_slot } from './resource_limits.js';
import { ErrorType, ProviderError } from './types.js';

export interface HttpJsonOptions extends RequestInit {
	expectedStatuses?: number[];
	max_response_bytes?: number;
}

export const MAX_HTTP_RESPONSE_BYTES = 25 * 1024 * 1024;

const read_bounded_body = async (
	res: Response,
	provider: string,
	limit: number,
	signal?: AbortSignal,
): Promise<string> => {
	if (!res.body) return '';
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await with_abort_signal(
				() => reader.read(),
				signal,
			);
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) {
				throw new ProviderError(
					ErrorType.PROVIDER_ERROR,
					'Provider response exceeds byte limit',
					provider,
					{
						status: res.status,
						retryable: false,
						cause: 'response_too_large',
					},
				);
			}
			consume_response_bytes(value.byteLength);
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join('');
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
};

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

export const retry_after_details = (
	value: string | null,
	now = Date.now(),
): { reset_time?: Date; retryable?: false } => {
	if (!value) return {};
	const text = value.trim();
	if (/^\d+$/.test(text)) {
		const seconds = Number(text);
		// An unrepresentable but valid delay must disable retry, not
		// disappear or overflow into an immediate timer.
		if (
			!Number.isSafeInteger(seconds) ||
			seconds > (8_640_000_000_000_000 - now) / 1000
		) {
			return { retryable: false };
		}
		return { reset_time: new Date(now + seconds * 1000) };
	}
	const timestamp = /^[a-z]{3}/i.test(text) ? Date.parse(text) : NaN;
	return Number.isFinite(timestamp)
		? { reset_time: new Date(timestamp) }
		: {};
};

export const http_json = async <T = any>(
	provider: string,
	url: string,
	options: HttpJsonOptions = {},
): Promise<T> => {
	const max_response_bytes =
		options.max_response_bytes ?? MAX_HTTP_RESPONSE_BYTES;
	if (
		!Number.isSafeInteger(max_response_bytes) ||
		max_response_bytes < 1 ||
		max_response_bytes > MAX_HTTP_RESPONSE_BYTES
	) {
		throw new RangeError(
			'max_response_bytes must be between 1 byte and 25 MiB',
		);
	}
	const signal = combine_request_signal(options.signal);
	let res: Response;
	let raw: string;
	try {
		({ res, raw } = await with_abort_signal(
			() =>
				with_provider_slot(provider, signal, async () => {
					// Keep the permit until fetch itself settles, not just its abort race.
					const res = await fetch(url, { ...options, signal });
					if (signal?.aborted) {
						void res.body?.cancel().catch(() => {});
						throw_if_aborted(signal);
					}
					const raw = await read_bounded_body(
						res,
						provider,
						max_response_bytes,
						signal,
					);
					return { res, raw };
				}),
			signal,
		));
	} catch (error) {
		throw_if_aborted(signal);
		if (error instanceof TypeError) {
			throw new ProviderError(
				ErrorType.API_ERROR,
				'Network request failed',
				provider,
				{ retryable: true, cause: 'network' },
			);
		}
		throw error;
	}
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
			...retry_after_details(res.headers.get('Retry-After')),
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
				handle_rate_limit(provider, details.reset_time, details);
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
					`Provider rejected the request (HTTP ${res.status})`,
					provider,
					details,
				);
		}
	}

	if (body === undefined) {
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'Provider returned invalid JSON',
			provider,
			{ status: res.status, retryable: false, cause: 'invalid_json' },
		);
	}
	return body as T;
};
