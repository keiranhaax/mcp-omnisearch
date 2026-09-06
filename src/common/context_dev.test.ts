import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../config/env.js';
import { context_dev_get, context_dev_post } from './context_dev.js';
import { ErrorType } from './types.js';

const fetch_mock = vi.fn();
const previous_key = config.search.context_dev.api_key;

beforeEach(() => {
	config.search.context_dev.api_key = 'fixture-key';
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
});

afterEach(() => {
	config.search.context_dev.api_key = previous_key;
	vi.unstubAllGlobals();
});

describe('Context.dev response validation', () => {
	it('rejects Context bodies beyond its bounded response budget', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ data: 'x'.repeat(8 * 1024 * 1024) }),
			),
		);
		await expect(context_dev_get('/fixture')).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
		});
	});
	it.each(['null', '"unexpected string"', '42'])(
		'rejects JSON scalars without a usable response contract',
		async (body) => {
			fetch_mock.mockResolvedValue(new Response(body));
			await expect(context_dev_get('/fixture')).rejects.toMatchObject(
				{ type: ErrorType.PROVIDER_ERROR },
			);
		},
	);
	it.each(['GET', 'POST'])(
		'rejects non-JSON %s responses',
		async (method) => {
			fetch_mock.mockResolvedValue(
				new Response('<html>gateway failure</html>'),
			);
			const pending =
				method === 'GET'
					? context_dev_get('/fixture')
					: context_dev_post('/fixture', {});
			await expect(pending).rejects.toMatchObject({
				type: ErrorType.PROVIDER_ERROR,
				provider: 'context_dev',
			});
		},
	);
});
