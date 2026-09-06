import { describe, expect, it } from 'vitest';
import {
	get_request_signal,
	run_with_request_context,
} from './request_context.js';

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
