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
	handle_provider_error,
	public_error_metadata,
} from '../common/errors.js';
import { http_json } from '../common/http.js';
import { run_with_request_context } from '../common/request_context.js';
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
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it('does not degrade upstream health for a local retention failure', () => {
	mark_provider_success('processing', 'fixture');
	const before = get_provider_health_snapshot();
	mark_provider_error(
		'processing',
		'fixture',
		new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'private',
			'fixture',
			{ cause: 'storage', retryable: false },
		),
	);
	expect(get_provider_health_snapshot()).toEqual(before);
});

describe('provider health HTTP integration', () => {
	const fetch_mock = vi.fn();
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
	});

	it.each([
		[401, 'authentication', 'provider_error'],
		[403, 'entitlement', 'entitlement_required'],
		[429, 'rate_limit', 'provider_error'],
		[404, 'endpoint_mismatch', 'endpoint_missing'],
		[503, 'upstream_failure', 'provider_error'],
		[504, 'timeout', 'provider_error'],
	] as const)(
		'records safe HTTP %s health without disabling registration',
		async (status, kind, runtime_status) => {
			fetch_mock.mockResolvedValueOnce(
				new Response(
					status === 404
						? 'Cannot POST /PRIVATE_PATH'
						: 'PRIVATE_BODY',
					{ status, headers: { 'X-Private': 'SECRET' } },
				),
			);
			const error = await http_json(
				'test_provider',
				'https://user:password@api.example.com/PRIVATE_PATH?token=SECRET',
			).catch((failure: unknown) => failure);
			mark_provider_error('search', 'test_provider', error);
			const state =
				get_provider_health_snapshot().search.test_provider;
			expect(state).toMatchObject({
				registered: true,
				active_error: true,
				last_error_kind: kind,
				last_runtime_status: runtime_status,
			});
			expect(state.last_error_kind).toBe(
				public_error_metadata(error).kind,
			);
			expect(
				JSON.stringify({
					state,
					logs: vi.mocked(console.warn).mock.calls,
				}),
			).not.toMatch(/PRIVATE|SECRET|password/);

			fetch_mock.mockResolvedValueOnce(new Response('{"ok":true}'));
			await expect(
				http_json('test_provider', 'https://api.example.com'),
			).resolves.toEqual({ ok: true });
			mark_provider_success('search', 'test_provider');
			const recovered =
				get_provider_health_snapshot().search.test_provider;
			expect(recovered).toMatchObject({
				registered: true,
				active_error: false,
				last_runtime_status: 'ok',
			});
			for (const field of [
				'last_error',
				'last_error_type',
				'last_error_kind',
				'last_error_at',
				'last_endpoint',
			])
				expect(recovered).not.toHaveProperty(field);
			expect(fetch_mock).toHaveBeenCalledTimes(2);
		},
	);

	it.each([
		['unknown', false],
		['unknown', true],
		['ok', false],
		['ok', true],
		['degraded', false],
		['degraded', true],
	] as const)(
		'leaves %s health untouched after HTTP cancellation (wrapped=%s)',
		async (prior, wrapped) => {
			if (prior === 'ok')
				mark_provider_success('search', 'test_provider');
			if (prior === 'degraded')
				mark_provider_error(
					'search',
					'test_provider',
					new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'private',
						'test_provider',
						{ status: 503 },
					),
				);
			const before = get_provider_health_snapshot();
			const summary_before = get_provider_health_summary();
			vi.mocked(console.warn).mockClear();
			const request = new AbortController();
			fetch_mock.mockImplementationOnce(
				(_url, options) =>
					new Promise((_resolve, reject) => {
						options.signal.addEventListener(
							'abort',
							() => reject(options.signal.reason),
							{ once: true },
						);
					}),
			);
			const pending = run_with_request_context(request.signal, () =>
				http_json('test_provider', 'https://api.example.com'),
			).catch((failure: unknown) => failure);
			await Promise.resolve();
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			request.abort(new Error('PRIVATE_REASON'));
			let error = await pending;
			if (wrapped) {
				try {
					handle_provider_error(error, 'test_provider');
				} catch (failure) {
					error = failure;
				}
			}
			mark_provider_error('search', 'test_provider', error);
			expect(get_provider_health_snapshot()).toEqual(before);
			expect(get_provider_health_summary()).toEqual(summary_before);
			expect(console.warn).not.toHaveBeenCalled();
			expect(public_error_metadata(error)).toMatchObject({
				kind: 'cancelled',
				retryable: false,
			});
		},
	);

	it('records an HTTP caller deadline as timeout rather than cancellation', async () => {
		const signal = AbortSignal.abort(
			new DOMException('PRIVATE_DEADLINE', 'TimeoutError'),
		);
		const error = await http_json(
			'test_provider',
			'https://api.example.com',
			{ signal },
		).catch((failure: unknown) => failure);
		mark_provider_error('search', 'test_provider', error);
		expect(
			get_provider_health_snapshot().search.test_provider,
		).toMatchObject({
			active_error: true,
			last_error_kind: 'timeout',
			last_error: 'Operation timed out',
		});
		expect(fetch_mock).not.toHaveBeenCalled();
		expect(
			JSON.stringify(get_provider_health_snapshot()),
		).not.toContain('PRIVATE_DEADLINE');
	});
});

describe('provider health privacy', () => {
	it('records outer deadline timeouts without exposing their reason', () => {
		mark_provider_error(
			'search',
			'fixture',
			new DOMException('private deadline', 'TimeoutError'),
		);
		expect(
			get_provider_health_snapshot().search.fixture,
		).toMatchObject({
			last_runtime_status: 'provider_error',
			last_error: 'Operation timed out',
			active_error: true,
		});
		expect(
			JSON.stringify(get_provider_health_snapshot()),
		).not.toContain('private deadline');
	});
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
			'last_error_kind',
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
