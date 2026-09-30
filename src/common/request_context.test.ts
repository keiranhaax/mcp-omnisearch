import { describe, expect, it } from 'vitest';
import {
	consume_response_bytes,
	get_request_signal,
	MAX_REQUEST_RESPONSE_BYTES,
	release_response_bytes,
	run_with_request_context,
} from './request_context.js';

describe('response byte budget', () => {
	it('rejects a crossing chunk without counting it and honours refunds', () => {
		run_with_request_context(undefined, () => {
			consume_response_bytes(MAX_REQUEST_RESPONSE_BYTES - 1);
			expect(() => consume_response_bytes(2)).toThrow(
				'Aggregate provider response exceeds byte limit',
			);
			// The rejected chunk was not counted: one more byte still fits.
			expect(() => consume_response_bytes(1)).not.toThrow();
			expect(() => consume_response_bytes(1)).toThrow();
			release_response_bytes(MAX_REQUEST_RESPONSE_BYTES);
			expect(() =>
				consume_response_bytes(MAX_REQUEST_RESPONSE_BYTES),
			).not.toThrow();
		});
	});

	it('is a no-op outside a request context', () => {
		expect(() => consume_response_bytes(1)).not.toThrow();
		expect(() => release_response_bytes(1)).not.toThrow();
	});
});

describe('request cancellation context', () => {
	it('isolates concurrent requests and restores nested contexts', async () => {
		const first = new AbortController();
		const second = new AbortController();
		expect(get_request_signal()).toBeUndefined();
		await Promise.all(
			[first, second].map(({ signal }) =>
				run_with_request_context(signal, async () => {
					await Promise.resolve();
					expect(get_request_signal()).toBe(signal);
					expect(
						run_with_request_context(undefined, get_request_signal),
					).toBeUndefined();
					expect(get_request_signal()).toBe(signal);
				}),
			),
		);
		expect(get_request_signal()).toBeUndefined();
	});
});
