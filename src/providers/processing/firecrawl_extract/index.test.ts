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
import { FirecrawlExtractProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.firecrawl_extract.api_key;
const previous_base_url =
	config.processing.firecrawl_extract.base_url;

const json_response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});

describe('FirecrawlExtractProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		vi.useFakeTimers();
		config.processing.firecrawl_extract.api_key = 'fc-test-key';
		config.processing.firecrawl_extract.base_url =
			'https://api.firecrawl.dev/v1/extract';
	});

	afterEach(() => {
		config.processing.firecrawl_extract.api_key = previous_api_key;
		config.processing.firecrawl_extract.base_url = previous_base_url;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('accepts structured extraction records without status success', async () => {
		fetch_mock
			.mockResolvedValueOnce(
				json_response({ success: true, id: 'extract-1' }),
			)
			.mockResolvedValueOnce(
				json_response({
					id: 'extract-1',
					status: 'completed',
					data: {
						title: 'Extracted title',
						tags: ['a', 'b'],
						author: { name: 'Author' },
					},
				}),
			);

		const promise = new FirecrawlExtractProvider().process_content(
			'https://extract.test',
		);
		await vi.advanceTimersByTimeAsync(3000);
		const result = await promise;

		expect(result).toMatchObject({
			content: expect.stringContaining('Extracted title'),
			metadata: { title: 'Extracted title' },
			source_provider: 'firecrawl_extract',
		});
		expect(result.content).toContain('- a');
		expect(result.content).toContain('- **name**: Author');
		expect(fetch_mock).toHaveBeenCalledTimes(2);
	});

	it('rejects malformed extracted data as non-retryable', async () => {
		const sentinel = 'extract-payload-secret-must-not-leak';
		fetch_mock
			.mockResolvedValueOnce(
				json_response({ success: true, id: 'extract-1' }),
			)
			.mockResolvedValueOnce(
				json_response({
					status: 'completed',
					data: sentinel,
				}),
			);

		const promise = new FirecrawlExtractProvider()
			.process_content('https://extract.test')
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(3000);
		const thrown = await promise;

		expect(thrown).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl_extract',
			message: 'Malformed firecrawl_extract response',
			details: { retryable: false },
		});
		expect(JSON.stringify(thrown)).not.toContain(sentinel);
		expect(fetch_mock).toHaveBeenCalledTimes(2);
	});
});
