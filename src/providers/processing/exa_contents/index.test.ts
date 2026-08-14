import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { ExaContentsProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.exa_contents.api_key;

describe('ExaContentsProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.exa_contents.api_key = 'exa-test-key';
	});

	afterEach(() => {
		config.processing.exa_contents.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('applies the configured abort timeout to contents requests', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-1',
					results: [
						{
							id: 'doc-1',
							title: 'Doc',
							url: 'https://example.com',
							text: 'content',
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await new ExaContentsProvider().process_content(
			'https://example.com',
		);
		expect(fetch_mock.mock.calls[0][1].signal).toBeInstanceOf(
			AbortSignal,
		);
	});

	it('accepts optional Exa response metadata being absent', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							id: 'doc-1',
							title: 'Doc',
							url: 'https://example.com',
							text: 'content',
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expect(
			new ExaContentsProvider().process_content('exa-result-id'),
		).resolves.toMatchObject({
			source_provider: 'exa_contents',
			metadata: { requestId: undefined },
		});
	});

	it('rejects private URLs and mixed URL/ID requests before fetching', async () => {
		const provider = new ExaContentsProvider();
		await expect(
			provider.process_content('http://127.0.0.1/private'),
		).rejects.toMatchObject({
			message: expect.stringContaining('Invalid URL'),
		});
		await expect(
			provider.process_content([
				'https://example.com',
				'exa-result-id',
			]),
		).rejects.toMatchObject({
			message:
				'Do not mix Exa result IDs and URLs in one contents request',
		});
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-1',
					results: { unexpected: true },
				}),
				{ status: 200 },
			),
		);

		await expect(
			new ExaContentsProvider().process_content('exa-result-id'),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'exa_contents',
			message: 'Malformed exa_contents response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
