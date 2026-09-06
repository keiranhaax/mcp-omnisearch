import { afterEach, expect, it, vi } from 'vitest';
import { BraveSearchProvider } from './brave/index.js';
import { config } from '../../config/env.js';
const previous = { ...config.search.brave };
afterEach(() => {
	Object.assign(config.search.brave, previous);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
it('includes retry attempts in the configured provider deadline', async () => {
	vi.useFakeTimers();
	vi.spyOn(Math, 'random').mockReturnValue(0);
	vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
		const controller = new AbortController();
		setTimeout(
			() =>
				controller.abort(new DOMException('timeout', 'TimeoutError')),
			ms,
		);
		return controller.signal;
	});
	config.search.brave.api_key = 'fixture-key';
	config.search.brave.timeout = 80;
	const fetch_mock = vi.fn(async () => {
		await new Promise((resolve) => setTimeout(resolve, 60));
		return fetch_mock.mock.calls.length === 1
			? new Response('{}', { status: 503 })
			: new Response('{"web":{"results":[]}}');
	});
	vi.stubGlobal('fetch', fetch_mock);
	let settled = false;
	const pending = new BraveSearchProvider()
		.search({ query: 'fixture' })
		.then(
			(result) => {
				settled = true;
				return result;
			},
			(error) => {
				settled = true;
				return error;
			},
		);
	await vi.advanceTimersByTimeAsync(81);
	expect(fetch_mock).toHaveBeenCalledTimes(2);
	expect(settled).toBe(true);
	await expect(pending).resolves.toMatchObject({
		name: 'TimeoutError',
	});
	await vi.advanceTimersByTimeAsync(100);
	expect(fetch_mock).toHaveBeenCalledTimes(2);
});
