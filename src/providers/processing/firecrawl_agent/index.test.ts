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

	it('returns the completed agent data', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({ success: true, id: 'agent-job-1' }),
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

	it('returns a resumable job payload when polling exhausts while still processing', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({ success: true, id: 'agent-job-2' }),
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
				'Firecrawl agent job is still processing. Retry the same request later for final output.',
			job_id: 'agent-job-2',
			status: 'processing',
			model: 'spark-1-mini',
			credits_used: 12,
		});
		// One start request plus 60 poll attempts.
		expect(fetch_mock).toHaveBeenCalledTimes(61);
	});
});
