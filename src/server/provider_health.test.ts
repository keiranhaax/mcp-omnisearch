import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { ErrorType, ProviderError } from '../common/types.js';
import {
	get_provider_health_snapshot,
	get_provider_health_summary,
	mark_provider_error,
	mark_provider_success,
	reset_provider_health,
} from './provider_health.js';

beforeEach(() => {
	reset_provider_health();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('provider health privacy', () => {
	it.each([
		'Invalid URL provided: file:///PRIVATE_PATH?SECRET',
		'Invalid URL provided: /PRIVATE_PATH?SECRET',
		'Invalid URL provided: https:broken PRIVATE_QUERY',
		'Invalid query: PRIVATE_QUERY',
	])('does not store or log rejected input: %s', (message) => {
		mark_provider_success('search', 'test_provider');
		const before = get_provider_health_snapshot();
		mark_provider_error(
			'search',
			'test_provider',
			new ProviderError(
				ErrorType.INVALID_INPUT,
				message,
				'test_provider',
				{ url: 'file:///PRIVATE_PATH?SECRET' },
			),
		);
		expect(get_provider_health_snapshot()).toEqual(before);
		expect(console.warn).not.toHaveBeenCalled();
	});
	it('clears stale error fields when a provider succeeds', () => {
		mark_provider_error(
			'search',
			'test_provider',
			new ProviderError(
				ErrorType.ENTITLEMENT_REQUIRED,
				'denied',
				'test_provider',
				{ url: 'https://api.example.com/v1/search' },
			),
		);
		mark_provider_success('search', 'test_provider');
		const state = get_provider_health_snapshot().search.test_provider;
		for (const field of [
			'last_error',
			'last_error_at',
			'last_error_type',
			'last_endpoint',
		]) {
			expect(state).not.toHaveProperty(field);
		}
		expect(state).toMatchObject({
			active_error: false,
			last_runtime_status: 'ok',
		});
		expect(get_provider_health_summary()).toEqual({
			ok: 1,
			unknown: 0,
			degraded: 0,
			total: 1,
		});
	});

	it('does not attribute a previous endpoint to a new error', () => {
		mark_provider_error(
			'search',
			'test_provider',
			new ProviderError(
				ErrorType.ENDPOINT_NOT_FOUND,
				'missing',
				'test_provider',
				{ url: 'https://api.example.com/v1/search' },
			),
		);
		mark_provider_error(
			'search',
			'test_provider',
			new ProviderError(
				ErrorType.API_ERROR,
				'failure',
				'test_provider',
			),
		);
		expect(
			get_provider_health_snapshot().search.test_provider,
		).not.toHaveProperty('last_endpoint');
	});
	it('retains only safe error classifications in shared status and logs', () => {
		mark_provider_error(
			'processing',
			'test_provider',
			new ProviderError(
				ErrorType.PROVIDER_ERROR,
				'PRIVATE_INPUT '.repeat(30_000),
				'test_provider',
				{
					status: 503,
					url: 'https://user:password@api.example.com/PRIVATE_PATH?signature=SECRET#fragment',
				},
			),
		);
		const snapshot = get_provider_health_snapshot();
		const serialized = JSON.stringify(snapshot);
		expect(
			/PRIVATE_INPUT|password|PRIVATE_PATH|SECRET|fragment/.test(
				serialized,
			),
		).toBe(false);
		expect(
			/PRIVATE_INPUT|password|PRIVATE_PATH|SECRET|fragment/.test(
				JSON.stringify(vi.mocked(console.warn).mock.calls),
			),
		).toBe(false);
		expect(snapshot.processing.test_provider).toMatchObject({
			last_error: 'Provider rejected the request (HTTP 503)',
			last_endpoint: 'https://api.example.com',
			last_error_type: ErrorType.PROVIDER_ERROR,
			last_runtime_status: 'provider_error',
		});
		expect(
			snapshot.processing.test_provider.last_error!.length,
		).toBeLessThanOrEqual(1024);
	});
});
