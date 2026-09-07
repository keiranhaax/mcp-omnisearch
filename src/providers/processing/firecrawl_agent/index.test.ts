import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { FirecrawlAgentProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.firecrawl_agent.api_key;
const previous_override_url =
	config.processing.firecrawl_agent.override_url;

const json_response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});

describe('FirecrawlAgentProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		vi.useFakeTimers();
		config.processing.firecrawl_agent.api_key = 'fc-test-key';
		config.processing.firecrawl_agent.override_url =
			'https://api.firecrawl.dev/v1/agent';
	});

	afterEach(() => {
		config.processing.firecrawl_agent.api_key = previous_api_key;
		config.processing.firecrawl_agent.override_url =
			previous_override_url;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('sets a conservative explicit budget and current model on every default create', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({
				success: true,
				id: '12345678-1234-4123-8123-123456789ab3',
			}),
		);
		fetch_mock.mockImplementation(async () =>
			json_response({ status: 'completed', data: 'done' }),
		);
		const promise = new FirecrawlAgentProvider().run_agent(
			'gather docs',
		);
		await vi.advanceTimersByTimeAsync(3000);
		await promise;
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({ maxCredits: 100, model: 'spark-2' });
	});

	it.each([0, -1, 1.5, NaN, Infinity])(
		'rejects invalid credit cap %s before creating a paid job',
		async (max_credits) => {
			await expect(
				new FirecrawlAgentProvider().run_agent('gather docs', {
					max_credits,
				}),
			).rejects.toMatchObject({ type: 'INVALID_INPUT' });
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('rejects a malformed provider job ID rather than interpolating it into a URL', async () => {
		fetch_mock.mockImplementation(async () =>
			json_response({ success: true, id: '../private' }),
		);
		const promise = new FirecrawlAgentProvider()
			.run_agent('docs')
			.catch((error) => error);
		await vi.advanceTimersByTimeAsync(1);
		expect(await promise).toMatchObject({
			type: 'PROVIDER_ERROR',
			details: { retryable: false },
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('defaults to the official v2 endpoint', () => {
		expect(config.processing.firecrawl_agent.base_url).toBe(
			'https://api.firecrawl.dev/v2/agent',
		);
	});

	it('never falls back from a private override after an endpoint failure', async () => {
		config.processing.firecrawl_agent.override_url =
			'https://private.test/agent';
		fetch_mock.mockImplementation(
			async () => new Response('Cannot POST /agent', { status: 404 }),
		);
		await expect(
			new FirecrawlAgentProvider().run_agent('private task'),
		).rejects.toBeInstanceOf(Error);
		expect(fetch_mock.mock.calls.map(([url]) => url)).toEqual([
			'https://private.test/agent',
		]);
	});

	it.each([null, false, 0])(
		'preserves completed falsy JSON %j',
		async (data) => {
			fetch_mock.mockImplementationOnce(async () =>
				json_response({
					success: true,
					id: '12345678-1234-4123-8123-123456789ab4',
				}),
			);
			fetch_mock.mockImplementation(async () =>
				json_response({ status: 'completed', data }),
			);
			const promise = new FirecrawlAgentProvider()
				.run_agent('gather docs')
				.catch((error) => error);
			await vi.advanceTimersByTimeAsync(3000);
			const result = await promise;
			expect(result.content).toBe(JSON.stringify(data));
			expect(result.metadata?.structured_data).toEqual(data);
		},
	);

	it('returns the completed agent data', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({
				success: true,
				id: '12345678-1234-4123-8123-123456789ab1',
			}),
		);
		fetch_mock.mockImplementation(async () =>
			json_response({
				success: true,
				status: 'completed',
				data: 'Gathered findings',
			}),
		);

		const promise = new FirecrawlAgentProvider().run_agent(
			'find the docs',
		);
		await vi.advanceTimersByTimeAsync(3000);
		const result = await promise;

		expect(result).toMatchObject({
			content: 'Gathered findings',
			source_provider: 'firecrawl_agent',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(2);
	});

	it.each([
		{
			label: 'malformed status',
			body: { status: 'invalid' },
			type: 'PROVIDER_ERROR',
		},
		{
			label: 'invalid JSON',
			raw: 'private-provider-echo',
			type: 'PROVIDER_ERROR',
		},
		{ label: 'authentication', status: 401, type: 'API_ERROR' },
		{
			label: 'entitlement',
			status: 403,
			type: 'ENTITLEMENT_REQUIRED',
		},
		{ label: 'missing job', status: 404, type: 'API_ERROR' },
		{
			label: 'failed job',
			body: { status: 'failed' },
			type: 'PROVIDER_ERROR',
		},
		{
			label: 'error job',
			body: { status: 'error' },
			type: 'PROVIDER_ERROR',
		},
		{
			label: 'cancelled job',
			body: { status: 'cancelled' },
			type: 'PROVIDER_ERROR',
		},
		{
			label: 'missing data',
			body: { status: 'completed' },
			type: 'PROVIDER_ERROR',
		},
	])(
		'retains the accepted ID and error on $label',
		async (fixture) => {
			const job_id = '12345678-1234-4123-8123-123456789abc';
			fetch_mock
				.mockResolvedValueOnce(
					json_response({ success: true, id: job_id }),
				)
				.mockResolvedValueOnce(
					new Response(
						fixture.raw ??
							JSON.stringify({
								...fixture.body,
								private: 'private-provider-echo',
							}),
						{ status: fixture.status ?? 200 },
					),
				);
			const promise = new FirecrawlAgentProvider()
				.run_agent('private-prompt')
				.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(3000);
			const error = await promise;
			if (fixture.body?.status === 'cancelled') {
				expect(error).toMatchObject({
					metadata: { job_id, status: 'cancelled' },
				});
				expect(
					fetch_mock.mock.calls.map(([, options]) => options.method),
				).toEqual(['POST', 'GET']);
				return;
			}
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({
				type: fixture.type,
				details: {
					job_id,
					recovery: expect.stringContaining('action="status"'),
				},
			});
			expect(JSON.stringify(error)).toContain('action=\\"cancel\\"');
			expect(JSON.stringify(error)).not.toContain('private-');
			expect(
				fetch_mock.mock.calls.map(([, options]) => options.method),
			).toEqual(['POST', 'GET']);
		},
	);

	it('returns a resumable job payload when polling exhausts while still processing', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({
				success: true,
				id: '12345678-1234-4123-8123-123456789ab2',
			}),
		);
		fetch_mock.mockImplementation(async () =>
			json_response({
				success: true,
				status: 'processing',
				model: 'spark-1-mini',
				creditsUsed: 12,
			}),
		);

		const promise = new FirecrawlAgentProvider().run_agent(
			'find the docs',
		);
		await vi.advanceTimersByTimeAsync(60 * 3000);
		const result = await promise;

		expect(JSON.parse(result.content)).toMatchObject({
			message:
				'Local wait stopped; the remote job may still be running. Use firecrawl_agent action="status" or action="cancel" with this job_id, not a new start.',
			job_id: '12345678-1234-4123-8123-123456789ab2',
			status: 'unknown',
			wait_interrupted: 'timeout',
		});
		// One start plus 59 polls; the deadline prevents a GET at expiry.
		expect(fetch_mock).toHaveBeenCalledTimes(60);
	});
});
