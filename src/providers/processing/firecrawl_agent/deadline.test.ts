import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { run_with_request_context } from '../../../common/request_context.js';
import { FirecrawlAgentProvider } from './index.js';
import { FirecrawlCrawlProvider } from '../firecrawl_crawl/index.js';
import { FirecrawlExtractProvider } from '../firecrawl_extract/index.js';

const fetch_mock = vi.fn();
const providers = [
	{
		name: 'firecrawl_agent' as const,
		run: () => new FirecrawlAgentProvider().run_agent('docs'),
	},
	{
		name: 'firecrawl_crawl' as const,
		run: () =>
			new FirecrawlCrawlProvider().process_content(
				'https://example.test',
			),
	},
	{
		name: 'firecrawl_extract' as const,
		run: () =>
			new FirecrawlExtractProvider().process_content(
				'https://example.test',
			),
	},
];
const previous = providers.map(({ name }) => ({
	name,
	...config.processing[name],
}));
describe('Firecrawl whole-job deadlines', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', fetch_mock);
		fetch_mock.mockReset();
		for (const { name } of providers) {
			config.processing[name].api_key = 'fc-test-key';
			config.processing[name].timeout = 100;
		}
	});
	afterEach(() => {
		for (const old of previous)
			Object.assign(config.processing[old.name], old);
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	it('retains the accepted agent job ID when a wait is cancelled', async () => {
		const job_id = '12345678-1234-4123-8123-123456789abc';
		fetch_mock.mockImplementation(
			async () =>
				new Response(JSON.stringify({ success: true, id: job_id })),
		);
		const controller = new AbortController();
		const promise = run_with_request_context(controller.signal, () =>
			new FirecrawlAgentProvider().run_agent('docs'),
		).catch((error) => error);
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		const result = await promise;
		expect(result.metadata).toMatchObject({
			job_id,
			status: 'unknown',
			wait_interrupted: 'cancelled',
		});
		expect(result.content).toContain('cancel');
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it.each(providers)(
		'$name includes start time in its total budget',
		async ({ run }) => {
			fetch_mock.mockImplementationOnce(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve(
									new Response(
										JSON.stringify({
											success: true,
											id: '12345678-1234-4123-8123-123456789ab5',
										}),
									),
								),
							80,
						),
					),
			);
			let settled = false;
			const result = run().then(
				(result) => {
					settled = true;
					return result;
				},
				(error) => {
					settled = true;
					return error;
				},
			);
			await vi.advanceTimersByTimeAsync(100);
			expect(settled).toBe(true);
			await result;
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			expect(fetch_mock.mock.calls[0][1].signal.aborted).toBe(true);
		},
	);
	it.each(providers)(
		'$name cancels an in-flight create without retrying',
		async ({ run }) => {
			fetch_mock.mockImplementation(() => new Promise(() => {}));
			const controller = new AbortController();
			let settled = false;
			const result = run_with_request_context(
				controller.signal,
				run,
			).catch((error) => {
				settled = true;
				return error;
			});
			await vi.advanceTimersByTimeAsync(1);
			controller.abort();
			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toBe(true);
			await result;
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			expect(fetch_mock.mock.calls[0][1].signal.aborted).toBe(true);
		},
	);
});
