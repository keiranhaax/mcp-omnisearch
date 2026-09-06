import { describe, expect, it } from 'vitest';
import {
	with_provider_slot,
	get_resource_snapshot,
	PROVIDER_CONCURRENCY,
	PROVIDER_QUEUE_LIMIT,
} from './resource_limits.js';
import {
	consume_response_bytes,
	run_with_request_context,
	MAX_REQUEST_RESPONSE_BYTES,
} from './request_context.js';

describe('provider resource limits', () => {
	it('shares admission across callers and removes cancelled queued work', async () => {
		let finish: () => void = () => {};
		const blocker = new Promise<void>(
			(resolve) => (finish = resolve),
		);
		const running = Array.from({ length: PROVIDER_CONCURRENCY }, () =>
			with_provider_slot('fixture', undefined, () => blocker),
		);
		await Promise.resolve();
		let queued_ran = false;
		const controller = new AbortController();
		const cancelled = with_provider_slot(
			'fixture',
			controller.signal,
			async () => {
				queued_ran = true;
			},
		).catch((error) => error);
		await Promise.resolve();
		expect(get_resource_snapshot().providers.fixture.active).toBe(
			PROVIDER_CONCURRENCY,
		);
		expect(get_resource_snapshot().providers.fixture.queued).toBe(1);
		controller.abort();
		await expect(cancelled).resolves.toMatchObject({
			name: 'AbortError',
		});
		expect(queued_ran).toBe(false);
		expect(get_resource_snapshot().providers.fixture.queued).toBe(0);
		finish();
		await Promise.all(running);
		expect(get_resource_snapshot().providers.fixture.active).toBe(0);
	});
	it('rejects overflow rather than allocating an unbounded waiting queue', async () => {
		let finish: () => void = () => {};
		const blocker = new Promise<void>(
			(resolve) => (finish = resolve),
		);
		const running = Array.from({ length: PROVIDER_CONCURRENCY }, () =>
			with_provider_slot('overflow', undefined, () => blocker),
		);
		const queued = Array.from({ length: PROVIDER_QUEUE_LIMIT }, () =>
			with_provider_slot('overflow', undefined, async () => 'done'),
		);
		await expect(
			with_provider_slot(
				'overflow',
				undefined,
				async () => 'unexpected',
			),
		).rejects.toMatchObject({
			type: 'RATE_LIMIT',
			details: { retryable: false },
		});
		finish();
		await Promise.all([...running, ...queued]);
		expect(get_resource_snapshot().providers.overflow.queued).toBe(0);
	});
	it('keeps a slot until non-cooperative work settles after cancellation', async () => {
		let finish: () => void = () => {};
		const controller = new AbortController();
		const pending = with_provider_slot(
			'settlement',
			controller.signal,
			() => new Promise<void>((resolve) => (finish = resolve)),
		);
		await Promise.resolve();
		controller.abort();
		expect(get_resource_snapshot().providers.settlement.active).toBe(
			1,
		);
		finish();
		await pending;
		expect(get_resource_snapshot().providers.settlement.active).toBe(
			0,
		);
	});
	it('shares the aggregate response budget across nested retries but isolates calls', () => {
		run_with_request_context(undefined, () => {
			consume_response_bytes(MAX_REQUEST_RESPONSE_BYTES - 1);
			run_with_request_context(undefined, () =>
				consume_response_bytes(1),
			);
			expect(() => consume_response_bytes(1)).toThrow(
				'Aggregate provider response exceeds byte limit',
			);
		});
		expect(() =>
			run_with_request_context(undefined, () =>
				consume_response_bytes(MAX_REQUEST_RESPONSE_BYTES),
			),
		).not.toThrow();
	});
});
