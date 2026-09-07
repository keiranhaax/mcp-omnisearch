import { describe, expect, it } from 'vitest';
import {
	with_provider_slot,
	get_resource_snapshot,
	PROVIDER_CONCURRENCY,
	PROVIDER_QUEUE_LIMIT,
	with_local_fetch_slot,
	get_local_fetch_snapshot,
	LOCAL_FETCH_QUEUE_LIMIT,
	LOCAL_FETCH_RESERVATION_BYTES,
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

describe('local fetch resource leases', () => {
	it('reserves before work and keeps capacity until cancelled work settles', async () => {
		const controller = new AbortController();
		let finish!: () => void;
		const running = with_local_fetch_slot(
			controller.signal,
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		await Promise.resolve();
		expect(get_local_fetch_snapshot()).toMatchObject({
			active: 1,
			reserved_bytes: LOCAL_FETCH_RESERVATION_BYTES,
		});
		controller.abort();
		expect(get_local_fetch_snapshot().active).toBe(1);
		finish();
		await expect(running).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(get_local_fetch_snapshot()).toMatchObject({
			active: 0,
			queued: 0,
			reserved_bytes: 0,
		});
	});
	it('bounds the URL-only queue and removes cancelled waiters', async () => {
		let finish!: () => void;
		const running = with_local_fetch_slot(
			undefined,
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		await Promise.resolve();
		const controllers = Array.from(
			{ length: LOCAL_FETCH_QUEUE_LIMIT },
			() => new AbortController(),
		);
		const queued = controllers.map((controller) =>
			with_local_fetch_slot(controller.signal, async () => {
				throw new Error('cancelled queue ran');
			}).catch((error) => error),
		);
		await expect(
			with_local_fetch_slot(undefined, async () => {}),
		).rejects.toMatchObject({
			type: 'RATE_LIMIT',
			details: { retryable: false },
		});
		expect(get_local_fetch_snapshot().reserved_bytes).toBe(
			LOCAL_FETCH_RESERVATION_BYTES,
		);
		controllers.forEach((controller) => controller.abort());
		expect(
			(await Promise.all(queued)).every(
				(error) => error.name === 'AbortError',
			),
		).toBe(true);
		expect(get_local_fetch_snapshot().queued).toBe(0);
		finish();
		await running;
		expect(get_local_fetch_snapshot().reserved_bytes).toBe(0);
	});
	it('releases reservations after errors and admits the next operation', async () => {
		await expect(
			with_local_fetch_slot(undefined, async () => {
				throw new Error('fixture');
			}),
		).rejects.toThrow('fixture');
		await expect(
			with_local_fetch_slot(undefined, async () => 42),
		).resolves.toBe(42);
		expect(get_local_fetch_snapshot()).toMatchObject({
			active: 0,
			queued: 0,
			reserved_bytes: 0,
		});
	});
});
