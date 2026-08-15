import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { ErrorType } from '../../../common/types.js';
import { config } from '../../../config/env.js';
import { FirecrawlActionsProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.firecrawl_actions.api_key;
const previous_base_url =
	config.processing.firecrawl_actions.base_url;

const json_response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});

describe('FirecrawlActionsProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_actions.api_key = 'fc-test-key';
		config.processing.firecrawl_actions.base_url =
			'https://api.firecrawl.dev/v2/scrape';
	});

	afterEach(() => {
		config.processing.firecrawl_actions.api_key = previous_api_key;
		config.processing.firecrawl_actions.base_url = previous_base_url;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('accepts optional action fields and metadata extensions', async () => {
		fetch_mock.mockResolvedValue(
			json_response({
				success: true,
				data: {
					markdown: 'Loaded content',
					screenshot: 'shot.png',
					actions: { screenshots: ['step.png'] },
					metadata: { contentType: 'text/html' },
				},
			}),
		);

		const result =
			await new FirecrawlActionsProvider().process_content(
				'https://dynamic.test',
				'advanced',
			);

		expect(result).toMatchObject({
			content: expect.stringContaining('Loaded content'),
			raw_contents: [
				{ url: 'https://dynamic.test', content: result.content },
			],
			metadata: { screenshot: 'shot.png', extract_depth: 'advanced' },
			source_provider: 'firecrawl_actions',
		});
		const sent_actions = JSON.parse(fetch_mock.mock.calls[0][1].body)
			.actions as Array<{ type: string }>;
		expect(sent_actions.map((action) => action.type)).toEqual([
			'wait',
			'scroll',
			'wait',
			'scroll',
			'wait',
			'click',
			'wait',
		]);
	});

	it('rejects malformed action data as non-retryable', async () => {
		const sentinel = 'actions-payload-secret-must-not-leak';
		fetch_mock.mockResolvedValue(
			json_response({ success: true, data: sentinel }),
		);

		let thrown: unknown;
		try {
			await new FirecrawlActionsProvider().process_content(
				'https://dynamic.test',
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl_actions',
			message: 'Malformed firecrawl_actions response',
			details: { retryable: false },
		});
		expect(JSON.stringify(thrown)).not.toContain(sentinel);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
