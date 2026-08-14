import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { parse_provider_response } from './provider_response.js';
import { ErrorType, ProviderError } from './types.js';

describe('parse_provider_response', () => {
	const schema = v.object({
		results: v.array(
			v.object({
				title: v.string(),
				url: v.string(),
			}),
		),
	});

	it('returns runtime-validated provider payloads', () => {
		expect(
			parse_provider_response('tavily', schema, {
				results: [{ title: 'Docs', url: 'https://example.com' }],
			}),
		).toEqual({
			results: [{ title: 'Docs', url: 'https://example.com' }],
		});
	});

	it('rejects malformed payloads without exposing response values', () => {
		const secret = 'response-secret-must-not-leak';
		let thrown: unknown;

		try {
			parse_provider_response('tavily', schema, {
				results: [{ title: 'Docs', api_key: secret }],
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ProviderError);
		expect(thrown).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'tavily',
			message: 'Malformed tavily response',
			details: { retryable: false },
		});
		expect(JSON.stringify(thrown)).not.toContain(secret);
	});
});
