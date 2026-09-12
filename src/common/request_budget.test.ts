import { afterEach, expect, it, vi } from 'vitest';
import { http_json } from './http.js';
import { run_with_request_context } from './request_context.js';
import { retry_with_backoff } from './retry.js';

afterEach(() => vi.unstubAllGlobals());

it('prevents hidden redirect hops when an HTTP budget is active', async () => {
	const fetch_mock = vi.fn(
		async (_url: unknown, _options: RequestInit) =>
			Response.json({ ok: true }),
	);
	vi.stubGlobal('fetch', fetch_mock);
	await run_with_request_context(
		undefined,
		() => http_json('fixture', 'https://example.test/api'),
		{ http_budget: { limit: 2, used: 0 } },
	);
	expect(fetch_mock.mock.calls[0][1].redirect).toBe('error');
});

it('isolates concurrent request budgets and inherits them in nested contexts', async () => {
	const fetch_mock = vi.fn(async () => Response.json({ ok: true }));
	vi.stubGlobal('fetch', fetch_mock);
	const budgets = [
		{ limit: 1, used: 0 },
		{ limit: 2, used: 0 },
	];
	await Promise.all(
		budgets.map((budget) =>
			run_with_request_context(
				undefined,
				async () => {
					await Promise.resolve();
					for (let n = 0; n < budget.limit; n++)
						await run_with_request_context(undefined, () =>
							http_json('fixture', 'https://example.test/api'),
						);
					await expect(
						http_json('fixture', 'https://example.test/api'),
					).rejects.toMatchObject({
						details: { cause: 'request_budget' },
					});
				},
				{ http_budget: budget },
			),
		),
	);
	expect(budgets.map((budget) => budget.used)).toEqual([1, 2]);
	expect(fetch_mock).toHaveBeenCalledTimes(3);
	await http_json('fixture', 'https://example.test/api');
	expect(fetch_mock).toHaveBeenCalledTimes(4);
});

it('caps actual HTTP attempts including nested retries before dispatch', async () => {
	const fetch_mock = vi.fn(
		async () => new Response('{}', { status: 503 }),
	);
	vi.stubGlobal('fetch', fetch_mock);
	const budget = { limit: 2, used: 0 };
	await expect(
		run_with_request_context(
			undefined,
			() =>
				retry_with_backoff(
					() => http_json('fixture', 'https://example.test/api'),
					{ max_retries: 4, initial_delay: 0 },
				),
			{ http_budget: budget },
		),
	).rejects.toMatchObject({
		details: { cause: 'request_budget', retryable: false },
	});
	expect(fetch_mock).toHaveBeenCalledTimes(2);
	expect(budget.used).toBe(2);
});
