import { describe, expect, it } from 'vitest';
import {
	get_response_metadata,
	set_response_metadata,
	request_metadata,
	set_response_job,
} from './response_metadata.js';

describe('request-level response metadata', () => {
	it.each([0, 1.25, Number.MAX_VALUE])(
		'captures reported numeric measurements: %o',
		(value) => {
			const result = {};
			const raw = {
				response_time: value,
				usage: { credits: value, private_canary: 'secret' },
				body: 'private-canary',
			};
			set_response_metadata(result, raw);
			raw.usage.credits = -1;
			expect(get_response_metadata(result)).toEqual({
				response_time_seconds: value,
				usage: { credits: value },
			});
		},
	);

	it.each(
		[
			undefined,
			null,
			'1.67',
			'',
			true,
			-1,
			NaN,
			Infinity,
			-Infinity,
			{ private_canary: 'secret' },
			[],
		].map((value) => ({ value })),
	)('omits malformed numeric measurements: %o', ({ value }) => {
		const result = {};
		set_response_metadata(result, {
			request_id: 'safe-request',
			response_time: value,
			usage: { credits: value },
		});
		expect(get_response_metadata(result)).toEqual({
			request_id: 'safe-request',
		});
	});

	it.each(
		[undefined, null, [], 'private-canary', 1, true, {}].map(
			(raw) => ({ raw }),
		),
	)('ignores unknown response metadata: %o', ({ raw }) => {
		const result = {};
		set_response_metadata(result, raw);
		expect(get_response_metadata(result)).toBeUndefined();
	});

	it.each(
		[null, [], 1, 'private-canary', { tokens: 5 }].map((usage) => ({
			usage,
		})),
	)('ignores unknown usage shapes: %o', ({ usage }) => {
		const result = {};
		set_response_metadata(result, { usage });
		expect(get_response_metadata(result)).toBeUndefined();
	});

	it.each(['a', 'a'.repeat(128)])(
		'preserves safe request IDs at the length bounds: %s',
		(request_id) => {
			const result = {};
			set_response_metadata(result, { request_id });
			expect(get_response_metadata(result)).toEqual({ request_id });
		},
	);

	it.each([
		'',
		'a'.repeat(129),
		'leading space',
		'request\n',
		'Bearer private-canary',
		'https://private-canary.test/?token=secret',
		'private.canary',
		'ｒequest',
		null,
		123,
		{ private_canary: true },
	])('omits unsafe request IDs: %o', (request_id) => {
		const result = {};
		set_response_metadata(result, { request_id });
		expect(get_response_metadata(result)).toBeUndefined();
	});

	it('associates a request ID without mutating the legacy result', () => {
		const result = Object.freeze([{ title: 'Evidence' }]);
		const legacy_json = JSON.stringify(result);
		const legacy_keys = Reflect.ownKeys(result);

		set_response_metadata(result, { request_id: 'request-123_abc' });

		expect(get_response_metadata(result)).toEqual({
			request_id: 'request-123_abc',
		});
		expect(JSON.stringify(result)).toBe(legacy_json);
		expect(Reflect.ownKeys(result)).toEqual(legacy_keys);
		expect(get_response_metadata(result[0])).toBeUndefined();
		expect(get_response_metadata([])).toBeUndefined();
	});
});

describe('P2 metadata provenance', () => {
	it.each([0, 2.5])(
		'captures finite Exa USD without inventing credits: %s',
		(usd) => {
			const result: unknown[] = [];
			set_response_metadata(
				result,
				{
					requestId: 'safe-id',
					costDollars: { total: usd, header: 'private' },
					usage: { credits: 42 },
				},
				'exa',
			);
			expect(
				request_metadata(result, 'exa', 'search', 3),
			).toMatchObject({
				request_id: 'safe-id',
				usage: { usd },
				usage_source: 'provider_reported',
				usage_scope: 'request',
				elapsed_ms: 3,
			});
			expect(
				JSON.stringify(request_metadata(result, 'exa', 'search', 3)),
			).not.toContain('private');
		},
	);
	it.each(['1', -1, Infinity, NaN, null, {}, []])(
		'does not coerce malformed Exa costs: %o',
		(total) => {
			const result = {};
			set_response_metadata(
				result,
				{ costDollars: { total } },
				'exa',
			);
			expect(
				request_metadata(result, 'exa', 'search', 1),
			).toMatchObject({
				usage: null,
				usage_source: 'unknown',
				usage_scope: 'unknown',
			});
		},
	);
	it('treats repeated Agent observations as job usage, not additional charges', () => {
		const result = {};
		set_response_job(result, {
			id: 'safe-id',
			state: 'running',
			partial: false,
			resumable: true,
		});
		set_response_metadata(
			result,
			{ creditsUsed: 0 },
			'firecrawl_agent',
		);
		expect(
			request_metadata(result, 'firecrawl_agent', 'status', 0),
		).toMatchObject({
			usage: { credits: 0 },
			usage_scope: 'job',
			job: { state: 'running' },
		});
		expect(
			request_metadata(result, 'firecrawl_agent', 'status', 0).usage,
		).toEqual({ credits: 0 });
	});
	it.each([-1, NaN, Infinity])(
		'labels unmeasurable local elapsed time honestly: %s',
		(elapsed) => {
			expect(
				request_metadata(undefined, 'fixture', 'operation', elapsed)
					.elapsed_ms,
			).toBeNull();
		},
	);
});
