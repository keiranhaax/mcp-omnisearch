import * as v from 'valibot';
import { handle_provider_error } from './errors.js';
import { http_json } from './http.js';
import { was_served_from_cache } from './http_cache.js';
import { parse_provider_response } from './provider_response.js';
import { mark_response_cached } from './response_metadata.js';
import { retry_with_backoff } from './retry.js';

/**
 * One JSON request to a provider with the policy every simple provider
 * previously spelled out by hand: a per-attempt timeout that is also the
 * whole-call budget, bounded retries of transient failures, schema
 * validation of the response, and provider-error wrapping of anything
 * thrown while mapping. `map` runs inside the retried attempt so a
 * malformed body is classified exactly as before.
 */
export interface ProviderJsonRequest<
	TSchema extends v.GenericSchema,
> {
	url: string;
	method?: 'GET' | 'POST';
	headers: Record<string, string>;
	/** Objects are JSON-encoded; a string is sent as-is. */
	body?: unknown;
	/** Per-attempt timeout in ms; also the whole-call budget. */
	timeout_ms: number;
	schema: TSchema;
	/** Verb phrase for wrapped failures: `Failed to ${operation}`. */
	operation: string;
	/** Defaults to one retry of transient failures; use 0 for paid jobs. */
	max_retries?: number;
	signal?: AbortSignal;
	/**
	 * Whether an identical successful response may be reused from the
	 * optional in-process cache. Defaults to true: every caller here is
	 * an idempotent lookup. Set false for anything with side effects.
	 */
	cacheable?: boolean;
}

export const provider_json_request = <
	TSchema extends v.GenericSchema,
	TResult,
>(
	provider: string,
	request: ProviderJsonRequest<TSchema>,
	map: (data: v.InferOutput<TSchema>) => TResult | Promise<TResult>,
): Promise<TResult> =>
	retry_with_backoff(
		async () => {
			try {
				const raw = await http_json(provider, request.url, {
					method: request.method ?? 'GET',
					headers: request.headers,
					...(request.body !== undefined
						? {
								body:
									typeof request.body === 'string'
										? request.body
										: JSON.stringify(request.body),
							}
						: {}),
					signal: AbortSignal.timeout(request.timeout_ms),
					cacheable: request.cacheable ?? true,
				});
				const result = await map(
					parse_provider_response(provider, request.schema, raw),
				);
				// A replayed body made no provider call: its usage figures
				// were already charged and must not be reported again.
				if (
					was_served_from_cache(raw) &&
					result !== null &&
					typeof result === 'object'
				)
					mark_response_cached(result);
				return result;
			} catch (error) {
				handle_provider_error(error, provider, request.operation);
			}
		},
		{
			timeout_ms: request.timeout_ms,
			...(request.max_retries !== undefined
				? { max_retries: request.max_retries }
				: {}),
			...(request.signal ? { signal: request.signal } : {}),
		},
	);
