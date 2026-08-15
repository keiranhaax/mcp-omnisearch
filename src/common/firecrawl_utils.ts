import * as v from 'valibot';
import { http_json } from './http.js';
import { parse_provider_response } from './provider_response.js';
import { is_non_retryable_provider_error } from './retry.js';
import { ErrorType, ProviderError } from './types.js';

export const firecrawl_poll_status_schema = v.picklist([
	'scraping',
	'processing',
	'completed',
	'failed',
	'cancelled',
	'error',
]);

const firecrawl_polling_response_schema = v.object({
	success: v.optional(v.boolean()),
	status: firecrawl_poll_status_schema,
	error: v.optional(v.string()),
});

type FirecrawlPollingResponse = v.InferOutput<
	typeof firecrawl_polling_response_schema
>;

export const make_firecrawl_request = async <
	const TSchema extends v.BaseSchema<
		unknown,
		unknown,
		v.BaseIssue<unknown>
	>,
>(
	provider_name: string,
	base_url: string,
	api_key: string,
	body: Record<string, unknown>,
	timeout: number,
	schema: TSchema,
): Promise<v.InferOutput<TSchema>> => {
	const data = await http_json(provider_name, base_url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${api_key}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeout),
	});

	return parse_provider_response(provider_name, schema, data);
};

export function validate_firecrawl_response(
	response: { success?: boolean; error?: string },
	provider_name: string,
	error_prefix: string,
): asserts response is {
	success?: true;
	error?: undefined;
} {
	if (response.success === false || response.error) {
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			`${error_prefix}: ${response.error || 'Unknown error'}`,
			provider_name,
		);
	}
}

export interface PollingConfig {
	provider_name: string;
	status_url: string;
	api_key: string;
	max_attempts: number;
	poll_interval: number;
	timeout: number;
	/**
	 * When true, exhausting max_attempts returns the last successfully
	 * parsed non-terminal status result instead of throwing a timeout,
	 * so callers can surface a resumable job id. If no poll ever parsed
	 * (all transient failures), the timeout is still thrown.
	 */
	return_on_exhaustion?: boolean;
}

export const poll_firecrawl_job = async <
	const TSchema extends v.BaseSchema<
		unknown,
		unknown,
		v.BaseIssue<unknown>
	>,
>(
	config: PollingConfig,
	schema: TSchema,
): Promise<v.InferOutput<TSchema> & FirecrawlPollingResponse> => {
	let last_pending:
		| (v.InferOutput<TSchema> & FirecrawlPollingResponse)
		| undefined;

	for (let attempts = 0; attempts < config.max_attempts; attempts++) {
		await new Promise((resolve) =>
			setTimeout(resolve, config.poll_interval),
		);

		let status_result: v.InferOutput<TSchema> &
			FirecrawlPollingResponse;
		try {
			const raw_status_result = await http_json(
				config.provider_name,
				config.status_url,
				{
					method: 'GET',
					headers: {
						Authorization: `Bearer ${config.api_key}`,
						'Content-Type': 'application/json',
					},
					signal: AbortSignal.timeout(config.timeout),
				},
			);
			const polling_output = parse_provider_response(
				config.provider_name,
				firecrawl_polling_response_schema,
				raw_status_result,
			);
			const caller_output = parse_provider_response(
				config.provider_name,
				schema,
				raw_status_result,
			);
			// Spreading the validated polling output guarantees `status`
			// is present even when the caller schema omits it.
			status_result = Object.assign(
				{},
				caller_output,
				polling_output,
			);
		} catch (error) {
			if (is_non_retryable_provider_error(error)) {
				throw error;
			}
			continue;
		}

		if (
			status_result.success === false ||
			['error', 'failed', 'cancelled'].includes(status_result.status)
		) {
			throw new ProviderError(
				ErrorType.PROVIDER_ERROR,
				`Job failed: ${status_result.error || status_result.status}`,
				config.provider_name,
			);
		}

		if (status_result.status === 'completed') {
			return status_result;
		}

		last_pending = status_result;
	}

	if (config.return_on_exhaustion && last_pending) {
		return last_pending;
	}

	throw new ProviderError(
		ErrorType.PROVIDER_ERROR,
		'Job timed out - try again later or with a smaller scope',
		config.provider_name,
	);
};
