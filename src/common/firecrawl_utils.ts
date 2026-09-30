import * as v from 'valibot';
import { http_json } from './http.js';
import { parse_provider_response } from './provider_response.js';
import {
	delay,
	is_non_retryable_provider_error,
	is_retryable_error,
} from './retry.js';
import { ErrorType, ProviderError } from './types.js';
import {
	combine_request_signal,
	get_request_signal,
	run_with_request_context,
	throw_if_aborted,
	with_abort_signal,
} from './request_context.js';

export const firecrawl_format_types = [
	'markdown',
	'summary',
	'html',
	'rawHtml',
	'links',
	'screenshot',
	'json',
	'question',
	'highlights',
] as const;
export const firecrawl_format_schema = v.union([
	v.picklist(firecrawl_format_types),
	v.looseObject({ type: v.picklist(firecrawl_format_types) }),
]);

export const validate_firecrawl_formats = (
	formats: unknown,
	provider: string,
) => {
	if (
		formats !== undefined &&
		!v.safeParse(
			v.pipe(
				v.array(firecrawl_format_schema),
				v.minLength(1),
				v.maxLength(10),
			),
			formats,
		).success
	) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'Unsupported Firecrawl formats',
			provider,
			{ retryable: false },
		);
	}
};

export const firecrawl_poll_status_schema = v.picklist([
	'scraping',
	'processing',
	'completed',
	'failed',
	'cancelled',
	'error',
]);

const firecrawl_polling_response_schema = v.object({
	success: v.optional(v.boolean()),
	status: firecrawl_poll_status_schema,
	error: v.optional(v.string()),
});

interface FirecrawlPollingResponse {
	success?: boolean;
	status: string;
	error?: string;
}

export const make_firecrawl_request = async <
	const TSchema extends v.BaseSchema<
		unknown,
		unknown,
		v.BaseIssue<unknown>
	>,
>(
	provider_name: string,
	base_url: string,
	api_key: string,
	body: Record<string, unknown>,
	timeout: number,
	schema: TSchema,
	signal?: AbortSignal,
	options: {
		/** Only idempotent lookups (scrape, map, search) opt in. */
		cacheable?: boolean;
	} = {},
): Promise<v.InferOutput<TSchema>> => {
	// The per-call timer always applies; a caller signal only adds the
	// overall job budget or client cancellation on top of it.
	const budget = create_firecrawl_budget(timeout);
	const request_signal = signal
		? AbortSignal.any([signal, budget.signal])
		: budget.signal;
	try {
		const data = await with_abort_signal(
			() =>
				http_json(provider_name, base_url, {
					method: 'POST',
					// Never forward credentials or prompts to redirect targets,
					// including when a private endpoint override is configured.
					redirect: 'error',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(body),
					signal: request_signal,
					cacheable: options.cacheable === true,
				}),
			request_signal,
		);

		return parse_provider_response(provider_name, schema, data);
	} finally {
		budget.dispose();
	}
};

/**
 * Poll exhaustion keeps the job id so a caller can resume or cancel
 * instead of starting a duplicate paid job. `budget_expired` marks the
 * overall deadline case, which stays classified as a timeout publicly.
 */
export const firecrawl_job_timeout_error = (
	provider_name: string,
	job_id?: string,
	options: { budget_expired?: boolean } = {},
) =>
	new ProviderError(
		ErrorType.PROVIDER_ERROR,
		options.budget_expired
			? 'Operation timed out'
			: 'Job timed out - try again later or with a smaller scope',
		provider_name,
		{
			retryable: false,
			cause: options.budget_expired ? 'timeout' : 'poll_exhausted',
			...(job_id !== undefined ? { job_id } : {}),
		},
	);

/**
 * Best-effort remote cancellation after a local timeout or client cancel.
 * Runs outside the (possibly aborted) request context with its own short
 * deadline so an abandoned paid job stops billing. Failures are swallowed:
 * the caller's original outcome is what the client should see.
 */
export const cancel_firecrawl_job = async (
	provider_name: string,
	job_url: string,
	api_key: string,
	timeout = 5000,
): Promise<boolean> => {
	try {
		await run_with_request_context(undefined, () =>
			http_json(provider_name, job_url, {
				method: 'DELETE',
				redirect: 'error',
				headers: { Authorization: `Bearer ${api_key}` },
				signal: AbortSignal.timeout(timeout),
			}),
		);
		return true;
	} catch {
		return false;
	}
};

export function validate_firecrawl_response(
	response: { success?: boolean; error?: string },
	provider_name: string,
	error_prefix: string,
): asserts response is {
	success?: true;
	error?: undefined;
} {
	if (response.success === false || response.error) {
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			error_prefix,
			provider_name,
		);
	}
}

export const create_firecrawl_budget = (timeout: number) => {
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException('Operation timed out', 'TimeoutError'),
			),
		timeout,
	);
	timer.unref?.();
	const caller_signal = get_request_signal();
	return {
		signal: caller_signal
			? AbortSignal.any([controller.signal, caller_signal])
			: controller.signal,
		dispose: () => clearTimeout(timer),
	};
};

export interface PollingConfig {
	provider_name: string;
	status_url: string;
	api_key: string;
	/** Opaque provider job id, attached to exhaustion errors for recovery. */
	job_id?: string;
	max_attempts: number;
	poll_interval: number;
	/** Per-GET timeout; also the total budget if no signal is supplied. */
	timeout: number;
	/**
	 * When true, exhausting max_attempts returns the last successfully
	 * parsed non-terminal status result instead of throwing a timeout,
	 * so callers can surface a resumable job id. If no poll ever parsed
	 * (all transient failures), the timeout is still thrown.
	 */
	return_on_exhaustion?: boolean;
	/** Agent callers own terminal-state interpretation and evidence recovery. */
	return_terminal_status?: boolean;
	on_status?: (status: unknown) => void;
	/** Overall operation budget, separate from each GET timeout. */
	signal?: AbortSignal;
}

export const poll_firecrawl_job = async <
	const TSchema extends v.BaseSchema<
		unknown,
		unknown,
		v.BaseIssue<unknown>
	>,
>(
	config: PollingConfig,
	schema: TSchema,
): Promise<v.InferOutput<TSchema> & FirecrawlPollingResponse> => {
	let last_pending:
		| (v.InferOutput<TSchema> & FirecrawlPollingResponse)
		| undefined;

	const budget = config.signal
		? undefined
		: create_firecrawl_budget(config.timeout);
	const signal = combine_request_signal(
		config.signal ?? budget!.signal,
	)!;
	let next_poll_delay = config.poll_interval;
	try {
		for (
			let attempts = 0;
			attempts < config.max_attempts;
			attempts++
		) {
			await delay(next_poll_delay, signal);
			next_poll_delay = config.poll_interval;

			let status_result: v.InferOutput<TSchema> &
				FirecrawlPollingResponse;
			const attempt = create_firecrawl_budget(config.timeout);
			const attempt_signal = AbortSignal.any([
				signal,
				attempt.signal,
			]);
			try {
				const raw_status_result = await with_abort_signal(
					() =>
						http_json(config.provider_name, config.status_url, {
							method: 'GET',
							redirect: 'error',
							headers: {
								Authorization: `Bearer ${config.api_key}`,
								'Content-Type': 'application/json',
							},
							signal: attempt_signal,
						}),
					attempt_signal,
				);
				const polling_output = parse_provider_response(
					config.provider_name,
					config.return_terminal_status
						? v.object({
								...firecrawl_polling_response_schema.entries,
								status: v.pipe(v.string(), v.maxLength(64)),
							})
						: firecrawl_polling_response_schema,
					raw_status_result,
				);
				const caller_output = parse_provider_response(
					config.provider_name,
					schema,
					raw_status_result,
				);
				// Spreading the validated polling output guarantees `status`
				// is present even when the caller schema omits it.
				status_result = Object.assign(
					{},
					caller_output,
					polling_output,
				);
			} catch (error) {
				throw_if_aborted(signal);
				// Only this GET's own timer permits a retry of a timeout.
				if (attempt.signal.aborted) continue;
				if (
					(error instanceof Error &&
						['AbortError', 'TimeoutError'].includes(error.name)) ||
					is_non_retryable_provider_error(error) ||
					(error instanceof ProviderError &&
						!is_retryable_error(error))
				) {
					throw error;
				}
				const reset =
					error instanceof ProviderError
						? error.details?.reset_time
						: undefined;
				if (
					reset instanceof Date &&
					Number.isFinite(reset.getTime())
				) {
					next_poll_delay = Math.max(
						config.poll_interval,
						reset.getTime() - Date.now(),
					);
				}
				continue;
			} finally {
				attempt.dispose();
			}

			config.on_status?.(status_result);
			if (
				config.return_terminal_status &&
				(status_result.success === false ||
					!['scraping', 'processing', 'queued'].includes(
						status_result.status,
					))
			)
				return status_result;
			if (
				status_result.success === false ||
				['error', 'failed', 'cancelled'].includes(
					status_result.status,
				)
			) {
				throw new ProviderError(
					ErrorType.PROVIDER_ERROR,
					`Job failed: ${status_result.status}`,
					config.provider_name,
				);
			}

			if (status_result.status === 'completed') {
				return status_result;
			}

			last_pending = status_result;
		}

		if (config.return_on_exhaustion && last_pending) {
			return last_pending;
		}

		throw firecrawl_job_timeout_error(
			config.provider_name,
			config.job_id,
		);
	} catch (error) {
		// A caller timeout is cancellation, not provider wait exhaustion.
		throw_if_aborted(get_request_signal());
		if (
			config.return_on_exhaustion &&
			signal.aborted &&
			last_pending &&
			error instanceof Error &&
			error.name === 'TimeoutError'
		)
			return last_pending;
		throw error;
	} finally {
		budget?.dispose();
	}
};
