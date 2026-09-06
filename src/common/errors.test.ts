import { describe, expect, it } from 'vitest';
import {
	create_error_response,
	handle_provider_error,
	handle_rate_limit,
	sanitize_query,
} from './errors.js';
import { ErrorType, ProviderError } from './types.js';
import { is_retryable_error } from './retry.js';

describe('handle_rate_limit', () => {
	it('preserves a safe timeout message from an outer operation deadline', () => {
		expect(
			create_error_response(
				new DOMException('private reason', 'TimeoutError'),
			),
		).toEqual({ error: 'Operation timed out' });
	});
	it('keeps an invalid reset Date typed and disables retry', () => {
		expect(() =>
			handle_rate_limit('test_provider', new Date(NaN)),
		).toThrowError(
			expect.objectContaining({
				type: ErrorType.RATE_LIMIT,
				details: { retryable: false, reset_time: undefined },
			}),
		);
	});
	it('throws a provider error with the reset time in details', () => {
		const reset_time = new Date('2026-04-15T12:00:00.000Z');

		expect(() => handle_rate_limit('brave', reset_time)).toThrowError(
			expect.objectContaining({
				type: ErrorType.RATE_LIMIT,
				provider: 'brave',
				details: { reset_time },
				message:
					'Rate limit exceeded for brave. Reset at 2026-04-15T12:00:00.000Z',
			}),
		);
	});
});

describe('handle_provider_error', () => {
	it('does not retry application TypeErrors as network failures', () => {
		try {
			handle_provider_error(
				new TypeError('PRIVATE_MAPPING_INPUT'),
				'test_provider',
				'parse response',
			);
		} catch (error) {
			expect(is_retryable_error(error)).toBe(false);
			expect(error).toMatchObject({ details: { retryable: false } });
			expect((error as Error).message).not.toContain(
				'PRIVATE_MAPPING_INPUT',
			);
		}
	});
	it('rethrows existing provider errors unchanged', () => {
		const error = new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'already wrapped',
			'test_provider',
		);

		expect(() =>
			handle_provider_error(error, 'test_provider', 'fetch results'),
		).toThrow(error);
	});

	it('wraps generic errors without exposing their upstream message', () => {
		expect(() =>
			handle_provider_error(
				new Error('boom'),
				'tavily',
				'fetch search results',
			),
		).toThrowError(
			expect.objectContaining({
				type: ErrorType.API_ERROR,
				provider: 'tavily',
				message: 'Failed to fetch search results',
				details: { retryable: false },
			}),
		);
	});

	it.each(['AbortError', 'TimeoutError'])(
		'preserves %s classification through provider wrapping',
		(name) => {
			expect(() =>
				handle_provider_error(
					new DOMException('PRIVATE_INPUT', name),
					'test_provider',
				),
			).toThrowError(
				expect.objectContaining({
					type: ErrorType.API_ERROR,
					message:
						name === 'TimeoutError'
							? 'Operation timed out'
							: 'Operation cancelled',
					details: {
						retryable: false,
						cause: name === 'TimeoutError' ? 'timeout' : 'cancelled',
					},
				}),
			);
		},
	);
});

describe('sanitize_query', () => {
	it('trims whitespace and collapses newlines into spaces', () => {
		expect(sanitize_query('  hello\nworld\r\nagain  ')).toBe(
			'hello world again',
		);
	});
});

describe('create_error_response', () => {
	it('preserves only a validated Tavily task ID in safe recovery guidance', () => {
		const error = new ProviderError(
			ErrorType.RATE_LIMIT,
			'PRIVATE_PROMPT',
			'tavily_research',
			{ request_id: 'job-1' },
		);
		const message = create_error_response(error).error;
		expect(message).toContain('job-1');
		expect(message).toContain('action="status"');
		expect(message).not.toContain('PRIVATE_PROMPT');
		for (const request_id of [
			'../PRIVATE_PATH',
			'PRIVATE_QUERY with spaces',
			'a'.repeat(201),
		]) {
			expect(
				create_error_response(
					new ProviderError(
						ErrorType.API_ERROR,
						'private',
						'tavily_research',
						{ request_id },
					),
				).error,
			).not.toContain(request_id);
		}
	});
	it.each([
		'Invalid URL provided: file:///PRIVATE_PATH?SECRET',
		'Invalid URL provided: /PRIVATE_PATH?SECRET',
		'Invalid URL provided: https:broken PRIVATE_QUERY',
		'Invalid query: PRIVATE_QUERY',
	])('does not expose rejected input: %s', (message) => {
		const response = create_error_response(
			new ProviderError(
				ErrorType.INVALID_INPUT,
				message,
				'test_provider',
			),
		).error;
		expect(response).not.toMatch(/PRIVATE_PATH|PRIVATE_QUERY|SECRET/);
		expect(response).toContain('test_provider error [INVALID_INPUT]');
		expect(response).toMatch(
			/Use a public HTTP\(S\) URL|Check required fields/,
		);
	});

	it.each([
		'Result not found or expired',
		'Invalid result ID',
		'Offset must be a positive integer',
		'Limit must be an integer between 1 and 500',
		'Byte offset must be a non-negative safe integer',
		'Byte offset exceeds the selected line',
		'Byte offset must be on a UTF-8 character boundary',
		'Tavily supports at most 20 results',
		'Invalid URL provided; use a public HTTP(S) URL without credentials',
		'At least one URL is required',
		'A valid job_id is required',
		'storeInCache cannot be true when zeroDataRetention is enabled',
	])('preserves safe validation guidance: %s', (message) => {
		expect(
			create_error_response(
				new ProviderError(
					ErrorType.INVALID_INPUT,
					message,
					'test_provider',
				),
			).error,
		).toContain(message);
	});
	it.each([ErrorType.API_ERROR, ErrorType.PROVIDER_ERROR])(
		'never exposes arbitrary upstream %s messages',
		(type) => {
			const error = new ProviderError(
				type,
				'PRIVATE_INPUT '.repeat(30_000),
				'test_provider',
				{
					url: 'https://user:password@api.example.com/private-token?signature=SECRET#fragment',
					response: 'PRIVATE_INPUT',
				},
			);
			const response = create_error_response(error).error;
			expect(response).not.toMatch(
				/PRIVATE_INPUT|SECRET|password|private-token|fragment/,
			);
			expect(response).toContain(type);
			expect(response.length).toBeLessThanOrEqual(1024);
		},
	);
	it('formats provider errors with the provider prefix', () => {
		const error = new ProviderError(
			ErrorType.API_ERROR,
			'Invalid API key',
			'exa',
		);

		expect(create_error_response(error)).toEqual({
			error: 'exa error [API_ERROR]: Invalid API key',
		});
	});

	it('adds endpoint and guidance for entitlement and endpoint errors', () => {
		const entitlement_error = new ProviderError(
			ErrorType.ENTITLEMENT_REQUIRED,
			'API key does not have access to this endpoint',
			'test_provider',
			{ url: 'https://api.example.com/v1/search' },
		);
		expect(create_error_response(entitlement_error)).toEqual({
			error:
				'test_provider error [ENTITLEMENT_REQUIRED]: API key does not have access to this endpoint (endpoint: https://api.example.com) Verify API key plan/entitlement for this endpoint.',
		});

		const endpoint_error = new ProviderError(
			ErrorType.ENDPOINT_NOT_FOUND,
			'Endpoint not found',
			'firecrawl_agent',
			{ url: 'https://api.firecrawl.dev/v1/agent' },
		);
		expect(create_error_response(endpoint_error)).toEqual({
			error:
				'firecrawl_agent error [ENDPOINT_NOT_FOUND]: Endpoint not found (endpoint: https://api.firecrawl.dev) Verify endpoint configuration or set FIRECRAWL_AGENT_URL.',
		});
	});

	it('does not expose unclassified error messages', () => {
		expect(create_error_response(new Error('PRIVATE_INPUT'))).toEqual(
			{
				error: 'Unexpected error: operation failed',
			},
		);
	});
});
