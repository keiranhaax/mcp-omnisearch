import { ErrorType, ProviderError } from './types.js';

export const handle_rate_limit = (
	provider: string,
	reset_time?: Date,
): never => {
	throw new ProviderError(
		ErrorType.RATE_LIMIT,
		`Rate limit exceeded for ${provider}${
			reset_time ? `. Reset at ${reset_time.toISOString()}` : ''
		}`,
		provider,
		{ reset_time },
	);
};

export function handle_provider_error(
	error: unknown,
	provider_name: string,
	operation: string = 'operation',
): never {
	if (error instanceof ProviderError) {
		throw error;
	}
	throw new ProviderError(
		ErrorType.API_ERROR,
		`Failed to ${operation}: ${
			error instanceof Error ? error.message : 'Unknown error'
		}`,
		provider_name,
	);
}

export const sanitize_query = (query: string): string => {
	return query.trim().replace(/[\n\r]+/g, ' ');
};

export const create_error_response = (
	error: Error,
): { error: string } => {
	if (error instanceof ProviderError) {
		const detail_suffix =
			error.details &&
			typeof error.details === 'object' &&
			typeof error.details.url === 'string'
				? ` (endpoint: ${error.details.url})`
				: '';
		const guidance =
			error.type === ErrorType.ENTITLEMENT_REQUIRED
				? ' Verify API key plan/entitlement for this endpoint.'
				: error.type === ErrorType.ENDPOINT_NOT_FOUND
					? ' Verify endpoint configuration or set FIRECRAWL_AGENT_URL.'
					: '';
		return {
			error: `${error.provider} error [${error.type}]: ${error.message}${detail_suffix}${guidance}`,
		};
	}
	return {
		error: `Unexpected error: ${error.message}`,
	};
};
