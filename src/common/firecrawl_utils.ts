import * as v from 'valibot';
import { http_json } from './http.js';
import { parse_provider_response } from './provider_response.js';
import { ErrorType, ProviderError } from './types.js';

const firecrawl_response_schema = v.object({
	success: v.optional(v.boolean()),
	id: v.optional(v.string()),
	url: v.optional(v.string()),
	status: v.optional(v.string()),
	total: v.optional(v.number()),
	completed: v.optional(v.number()),
	data: v.optional(v.unknown()),
	links: v.optional(v.array(v.unknown())),
	warning: v.optional(v.nullable(v.string())),
	creditsUsed: v.optional(v.number()),
	model: v.optional(v.string()),
	expiresAt: v.optional(v.string()),
	error: v.optional(v.string()),
});

export type FirecrawlProviderResponse = v.InferOutput<
	typeof firecrawl_response_schema
>;

export const make_firecrawl_request = async <
	T extends FirecrawlProviderResponse = FirecrawlProviderResponse,
>(
	provider_name: string,
	base_url: string,
	api_key: string,
	body: Record<string, any>,
	timeout: number,
): Promise<T> => {
	const data = await http_json(provider_name, base_url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${api_key}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeout),
	});

	return parse_provider_response(
		provider_name,
		firecrawl_response_schema,
		data,
	) as T;
};

export const validate_firecrawl_response = (
	response: { success?: boolean; error?: string },
	provider_name: string,
	error_prefix: string,
): void => {
	if (response.success === false || response.error) {
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			`${error_prefix}: ${response.error || 'Unknown error'}`,
			provider_name,
		);
	}
};

export interface PollingConfig {
	provider_name: string;
	status_url: string;
	api_key: string;
	max_attempts: number;
	poll_interval: number;
	timeout: number;
}

export const poll_firecrawl_job = async <
	T extends {
		success?: boolean;
		status: string;
		error?: string;
		data?: any;
	},
>(
	config: PollingConfig,
): Promise<T> => {
	let attempts = 0;

	while (attempts < config.max_attempts) {
		await new Promise((resolve) =>
			setTimeout(resolve, config.poll_interval),
		);

		let status_result: T;
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
			status_result = parse_provider_response(
				config.provider_name,
				firecrawl_response_schema,
				raw_status_result,
			) as T;
		} catch (error) {
			if (
				error instanceof ProviderError &&
				error.details?.retryable === false
			) {
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

		attempts++;
	}

	throw new ProviderError(
		ErrorType.PROVIDER_ERROR,
		'Job timed out - try again later or with a smaller scope',
		config.provider_name,
	);
};
