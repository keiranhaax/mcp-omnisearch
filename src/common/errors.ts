import { ErrorType, ProviderError } from './types.js';

export const handle_rate_limit = (
	provider: string,
	reset_time?: Date,
	details: Record<string, unknown> = {},
): never => {
	if (reset_time && !Number.isFinite(reset_time.getTime())) {
		reset_time = undefined;
		details = { ...details, retryable: false };
	}
	throw new ProviderError(
		ErrorType.RATE_LIMIT,
		`Rate limit exceeded for ${provider}${
			reset_time ? `. Reset at ${reset_time.toISOString()}` : ''
		}`,
		provider,
		{ ...details, reset_time },
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
	if (
		error instanceof Error &&
		(error.name === 'AbortError' || error.name === 'TimeoutError')
	) {
		const timeout = error.name === 'TimeoutError';
		throw new ProviderError(
			ErrorType.API_ERROR,
			timeout ? 'Operation timed out' : 'Operation cancelled',
			provider_name,
			{ retryable: false, cause: timeout ? 'timeout' : 'cancelled' },
		);
	}

	throw new ProviderError(
		ErrorType.API_ERROR,
		`Failed to ${operation}`,
		provider_name,
		{ retryable: false },
	);
}

export const sanitize_query = (query: string): string => {
	return query.trim().replace(/[\n\r]+/g, ' ');
};

export const MAX_PUBLIC_ERROR_LENGTH = 1024;

// Paths can also contain bearer tokens; retain only the API origin.
export const safe_endpoint = (url: string): string => {
	try {
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol))
			return '[redacted endpoint]';
		return parsed.origin.slice(0, 256);
	} catch {
		return '[redacted endpoint]';
	}
};

const safe_messages = new Set([
	'Invalid API key',
	'Network request failed',
	'Operation timed out',
	'Operation cancelled',
	'Provider response exceeds byte limit',
	'Aggregate provider response exceeds byte limit',
	'Provider returned invalid JSON',
]);

const safe_validation_messages = new Set([
	'Invalid URL provided; use a public HTTP(S) URL without credentials',
	'Invalid public domain provided',
	'At least one URL is required',
	'This mode requires exactly one URL',
	'A maximum of 20 URLs is allowed per request',
	'Result not found or expired',
	'Invalid result ID',
	'Offset must be a positive integer',
	'Limit must be an integer between 1 and 500',
	'Byte offset must be a non-negative safe integer',
	'Byte offset exceeds the selected line',
	'Byte offset must be on a UTF-8 character boundary',
	'Tavily supports at most 20 results',
	'url is required',
	'domain is required',
	'query is required',
	'URL is required',
	'Query is required for search mode',
	'Search query is required',
	'Query is required for LLM context',
	'minResults must not exceed maxResults',
	'Unsupported Firecrawl formats',
	'A valid job_id is required',
	'A valid request_id is required',
	'Tavily status requires request_id only; research requires query only',
	'Prompt must contain 1 to 10000 characters',
	'max_credits must be a positive safe integer',
	'start requires prompt only; status/cancel require job_id only',
	'formats cannot be combined with question or highlights_query',
	'question and highlights_query cannot both be set',
	'storeInCache cannot be true when zeroDataRetention is enabled',
	'onlyCleanContent is not supported with zeroDataRetention',
	'includeDomains and excludeDomains cannot both be set',
	'firecrawl_options can only be used with provider=firecrawl and mode=scrape',
	'firecrawl_search_options can only be used with provider=firecrawl and mode=search',
	'At least one ID must be provided',
	'Do not mix Exa result IDs and URLs in one contents request',
	'A URL must be provided',
	'loc_lat must be between -90 and 90',
	'loc_long must be between -180 and 180',
	'Tavily chunk reranking requires a non-empty query and chunks_per_source must be an integer from 1 to 5',
	'Invalid GitHub search query',
	'Brave query exceeds API limits (400 characters / 50 words). Shorten the query.',
]);

export const public_error_message = (
	error: ProviderError,
): string => {
	switch (error.type) {
		case ErrorType.ENTITLEMENT_REQUIRED:
			return 'API key does not have access to this endpoint';
		case ErrorType.ENDPOINT_NOT_FOUND:
			return 'Endpoint not found';
		case ErrorType.RATE_LIMIT:
			return 'Rate limit exceeded';
		case ErrorType.INVALID_INPUT:
			// Only fixed local guidance is safe; rejected input may be
			// a path, malformed URL, or query with no recognizable scheme.
			if (safe_validation_messages.has(error.message))
				return error.message;
			if (error.message.startsWith('Invalid URL provided:'))
				return 'Invalid URL provided. Use a public HTTP(S) URL without credentials.';
			return 'Invalid input. Check required fields and allowed values in the tool schema.';
		default: {
			if (safe_messages.has(error.message)) return error.message;
			const status = error.details?.status;
			if (
				Number.isInteger(status) &&
				status >= 400 &&
				status <= 599
			) {
				return `Provider rejected the request (HTTP ${status})`;
			}
			return 'Provider request failed';
		}
	}
};

export const create_error_response = (
	error: unknown,
): { error: string } => {
	if (error instanceof Error && error.name === 'TimeoutError')
		return { error: 'Operation timed out' };
	if (error instanceof Error && error.name === 'AbortError')
		return { error: 'Operation cancelled' };
	if (error instanceof ProviderError) {
		const detail_suffix =
			typeof error.details?.url === 'string'
				? ` (endpoint: ${safe_endpoint(error.details.url)})`
				: '';
		const guidance =
			error.type === ErrorType.ENTITLEMENT_REQUIRED
				? ' Verify API key plan/entitlement for this endpoint.'
				: error.type === ErrorType.ENDPOINT_NOT_FOUND
					? ' Verify endpoint configuration or set FIRECRAWL_AGENT_URL.'
					: '';
		const provider = /^[a-z0-9_-]{1,64}$/i.test(error.provider)
			? error.provider
			: 'provider';
		const request_id = error.details?.request_id;
		const recovery =
			provider === 'tavily_research' &&
			typeof request_id === 'string' &&
			/^[a-zA-Z0-9_-]{1,200}$/.test(request_id)
				? ` Resume with ai_search provider="tavily_research", action="status", request_id="${request_id}"; do not start a new research task.`
				: '';
		return {
			error:
				`${provider} error [${error.type}]: ${public_error_message(error)}${detail_suffix}${guidance}${recovery}`.slice(
					0,
					MAX_PUBLIC_ERROR_LENGTH,
				),
		};
	}
	return { error: 'Unexpected error: operation failed' };
};
