import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { get_response_metadata } from '../../../common/response_metadata.js';
import { ExaSimilarProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.exa_similar.api_key;

describe('ExaSimilarProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.exa_similar.api_key = 'exa-test-key';
	});

	afterEach(() => {
		config.processing.exa_similar.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each([
		'Bearer CONTROL_CANARY',
		'x'.repeat(129),
		{ headers: 'CONTROL_CANARY' },
	])(
		'validates request metadata without altering similar-page evidence: %j',
		async (requestId) => {
			const url = 'https://example.com/docs?token=syntax&q=a%2Bb';
			const content = 'const api_key = "example"; $x^2$ [1]';
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						requestId,
						costDollars: { total: { config: 'CONTROL_CANARY' } },
						results: [{ id: 'doc:1', url, text: content }],
					}),
				),
			);
			const result = await new ExaSimilarProvider().process_content(
				url,
			);
			expect(result.metadata.requestId).toBeUndefined();
			expect(get_response_metadata(result)).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain('CONTROL_CANARY');
			expect(result.metadata.original_url).toBe(url);
			expect(result.raw_contents).toEqual([{ url, content }]);
		},
	);

	it('attaches safe response metadata to the root object', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-usage',
					costDollars: { total: 0 },
					results: [],
				}),
			),
		);
		const result = await new ExaSimilarProvider().process_content(
			'https://example.com',
		);
		expect(get_response_metadata(result)).toEqual({
			request_id: 'req-usage',
			usage: { usd: 0 },
		});
	});

	it('applies the configured abort timeout to similar-page requests', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ requestId: 'req-1', results: [] }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await new ExaSimilarProvider().process_content(
			'https://example.com',
		);
		expect(fetch_mock.mock.calls[0][1].signal).toBeInstanceOf(
			AbortSignal,
		);
	});

	it('accepts optional Exa metadata fields being absent', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							id: 'doc-1',
							title: 'Similar result',
							url: 'https://example.com/similar',
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expect(
			new ExaSimilarProvider().process_content('https://example.com'),
		).resolves.toMatchObject({
			source_provider: 'exa_similar',
			metadata: { requestId: undefined },
		});
	});

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: { unexpected: true } }),
				{ status: 200 },
			),
		);

		await expect(
			new ExaSimilarProvider().process_content('https://example.com'),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'exa_similar',
			message: 'Malformed exa_similar response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
