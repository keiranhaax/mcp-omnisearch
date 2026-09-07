import * as v from 'valibot';
import {
	create_firecrawl_budget,
	make_firecrawl_request,
	poll_firecrawl_job,
} from '../../../common/firecrawl_utils.js';
import {
	ErrorType,
	ProcessingResult,
	ProviderError,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/errors.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';
import { http_json } from '../../../common/http.js';
import { parse_provider_response } from '../../../common/provider_response.js';
import { validate_firecrawl_response } from '../../../common/firecrawl_utils.js';
import {
	get_job_failure,
	job_metadata,
	set_job_failure,
} from '../../../common/job_state.js';
import {
	set_response_job,
	set_response_metadata,
} from '../../../common/response_metadata.js';

const firecrawl_agent_start_schema = v.object({
	success: v.boolean(),
	id: v.optional(v.pipe(v.string(), v.uuid())),
	error: v.optional(v.string()),
});

const firecrawl_agent_status_schema = v.object({
	success: v.optional(v.boolean()),
	status: v.pipe(v.string(), v.maxLength(64)),
	data: v.optional(v.unknown()),
	model: v.optional(v.unknown()),
	creditsUsed: v.optional(v.unknown()),
	expiresAt: v.optional(v.unknown()),
	error: v.optional(v.string()),
});

type FirecrawlAgentStartResponse = v.InferOutput<
	typeof firecrawl_agent_start_schema
>;

interface ResolvedAgentStart {
	start_url: string;
	start_response: FirecrawlAgentStartResponse;
}

export class FirecrawlAgentProvider {
	name = 'firecrawl_agent';
	description =
		'Autonomous web data gathering agent powered by Firecrawl. Give it a natural language prompt and it autonomously searches, navigates, and extracts data from the web. No URLs required. Best for complex research tasks that require navigating multiple pages.';
	private async start_job(
		api_key: string,
		request_body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ResolvedAgentStart> {
		const start_url =
			config.processing.firecrawl_agent.override_url ||
			config.processing.firecrawl_agent.base_url;
		const raw_start = await make_firecrawl_request(
			this.name,
			start_url,
			api_key,
			request_body,
			config.processing.firecrawl_agent.timeout,
			v.unknown(),
			signal,
		);
		const identity = v.safeParse(
			v.object({
				success: v.literal(true),
				id: v.pipe(v.string(), v.uuid()),
			}),
			raw_start,
		);
		let start_response: FirecrawlAgentStartResponse;
		try {
			start_response = parse_provider_response(
				this.name,
				firecrawl_agent_start_schema,
				raw_start,
			);
		} catch (error) {
			if (identity.success && error instanceof ProviderError) {
				const job_id = identity.output.id;
				error.details = { ...error.details, job_id };
				const job = job_metadata(
					'firecrawl_agent',
					job_id,
					'unknown',
					false,
				);
				set_response_job(error, job);
				set_job_failure(error, job);
			}
			throw error;
		}
		if (!start_response.success || !start_response.id) {
			throw new ProviderError(
				ErrorType.PROVIDER_ERROR,
				'Failed to start agent: no job ID returned',
				this.name,
				{ retryable: false },
			);
		}
		return { start_url, start_response };
	}

	private job_result(
		job_id: string,
		status: v.InferOutput<typeof firecrawl_agent_status_schema>,
	): ProcessingResult {
		const job = job_metadata(
			'firecrawl_agent',
			job_id,
			status.status,
			status.status !== 'completed' &&
				status.data !== undefined &&
				status.data !== null,
		);
		if (status.success === false) {
			job.state = 'failed';
			job.resumable = false;
			job.partial = status.data !== undefined && status.data !== null;
			delete job.cancellation;
		}
		const known = job.state !== 'unknown';
		const data = known ? status.data : undefined;
		const metadata = {
			job_id,
			status: job.provider_status ?? 'unknown',
			model:
				typeof status.model === 'string' &&
				/^[a-zA-Z0-9_-]{1,64}$/.test(status.model)
					? status.model
					: undefined,
			structured_data: data,
			credits_used:
				typeof status.creditsUsed === 'number' &&
				Number.isFinite(status.creditsUsed) &&
				status.creditsUsed >= 0
					? status.creditsUsed
					: undefined,
			expires_at:
				typeof status.expiresAt === 'string' &&
				status.expiresAt.length <= 64 &&
				Number.isFinite(Date.parse(status.expiresAt))
					? status.expiresAt
					: undefined,
			title: `Firecrawl agent job ${job_id}`,
		};
		const content =
			status.status === 'completed' || job.partial
				? typeof data === 'string'
					? data
					: JSON.stringify(data, null, 2)
				: JSON.stringify(
						{
							...metadata,
							message:
								status.status === 'cancelled'
									? 'Firecrawl agent job was cancelled.'
									: 'Firecrawl agent job is still processing. Call firecrawl_agent with action="status" and this job_id; do not start a new job.',
						},
						null,
						2,
					);
		const result: ProcessingResult = {
			content: content ?? '',
			metadata: {
				...metadata,
				word_count: (content ?? '').split(/\s+/).filter(Boolean)
					.length,
			},
			source_provider: this.name,
		};
		set_response_metadata(result, status, this.name);
		if (content === undefined) {
			job.state = 'unknown';
			job.resumable = true;
		}
		if (!known || content === undefined) job.partial = false;
		set_response_job(result, job);
		if (job.state === 'failed' || job.state === 'unknown') {
			const error = new ProviderError(
				ErrorType.PROVIDER_ERROR,
				'Agent job did not complete successfully',
				this.name,
				{ retryable: false, job_id, status: job.provider_status },
			);
			set_response_metadata(error, status, this.name);
			set_response_job(error, job);
			throw set_job_failure(
				error,
				job,
				job.partial ? result : undefined,
			);
		}
		return result;
	}

	async manage_job(
		action: 'status' | 'cancel',
		job_id: string,
	): Promise<ProcessingResult> {
		if (!v.safeParse(v.pipe(v.string(), v.uuid()), job_id).success) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'A valid job_id is required',
				this.name,
			);
		}
		const api_key = validate_api_key(
			config.processing.firecrawl_agent.api_key,
			this.name,
		);
		const base_url =
			config.processing.firecrawl_agent.override_url ||
			config.processing.firecrawl_agent.base_url;
		try {
			const raw = await http_json(
				this.name,
				`${base_url.replace(/\/$/, '')}/${job_id}`,
				{
					method: action === 'status' ? 'GET' : 'DELETE',
					redirect: 'error',
					headers: { Authorization: `Bearer ${api_key}` },
					signal: AbortSignal.timeout(
						config.processing.firecrawl_agent.timeout,
					),
				},
			);
			if (action === 'cancel') {
				const cancelled = parse_provider_response(
					this.name,
					v.object({
						success: v.boolean(),
						error: v.optional(v.string()),
					}),
					raw,
				);
				validate_firecrawl_response(
					cancelled,
					this.name,
					'Agent cancellation failed',
				);
				return this.job_result(job_id, { status: 'cancelled' });
			}
			return this.job_result(
				job_id,
				parse_provider_response(
					this.name,
					firecrawl_agent_status_schema,
					raw,
				),
			);
		} catch (error) {
			try {
				handle_provider_error(error, this.name, 'manage agent job');
			} catch (wrapped) {
				if (
					!(wrapped instanceof ProviderError) ||
					get_job_failure(wrapped)
				)
					throw wrapped;
				wrapped.details = { ...wrapped.details, job_id };
				const job = job_metadata(
					'firecrawl_agent',
					job_id,
					'unknown',
					false,
				);
				if (action === 'cancel') job.cancellation = 'unconfirmed';
				set_response_job(wrapped, job);
				throw set_job_failure(wrapped, job);
			}
		}
	}

	async run_agent(
		prompt: string,
		options?: {
			model?: 'spark-2' | 'spark-1-mini' | 'spark-1-pro';
			max_credits?: number;
			wait_for_completion?: boolean;
		},
	): Promise<ProcessingResult> {
		if (
			!prompt ||
			prompt.trim().length === 0 ||
			prompt.length > 10000
		) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Prompt must contain 1 to 10000 characters',
				this.name,
			);
		}

		const max_credits = options?.max_credits ?? 100;
		if (!Number.isSafeInteger(max_credits) || max_credits <= 0) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'max_credits must be a positive safe integer',
				this.name,
			);
		}

		const agent_request = async () => {
			const api_key = validate_api_key(
				config.processing.firecrawl_agent.api_key,
				this.name,
			);

			const budget = create_firecrawl_budget(
				config.processing.firecrawl_agent.timeout,
			);
			let accepted_job_id: string | undefined;
			let last_observed:
				| v.InferOutput<typeof firecrawl_agent_status_schema>
				| undefined;
			let last_evidence: unknown;
			try {
				const request_body: Record<string, any> = {
					prompt: prompt.trim(),
					model: options?.model ?? 'spark-2',
					maxCredits: max_credits,
				};

				const { start_response, start_url } = await this.start_job(
					api_key,
					request_body,
					budget.signal,
				);

				if (!start_response.success || !start_response.id) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						`Failed to start agent: ${start_response.error || 'No job ID returned'}`,
						this.name,
					);
				}

				const job_id = start_response.id;
				accepted_job_id = job_id;
				if (options?.wait_for_completion === false) {
					const result = this.job_result(job_id, {
						status: 'processing',
					});
					// The legacy body says processing; creation alone does not
					// establish a provider-observed queued/running state.
					set_response_job(
						result,
						job_metadata('firecrawl_agent', job_id, undefined, false),
					);
					return result;
				}
				const status_url = `${start_url}/${job_id}`;

				const poll_result = await poll_firecrawl_job(
					{
						provider_name: this.name,
						status_url,
						api_key,
						max_attempts: 60,
						poll_interval: 3000,
						timeout: 30000,
						signal: budget.signal,
						return_on_exhaustion: true,
						return_terminal_status: true,
						on_status: (raw) => {
							const next = raw as v.InferOutput<
								typeof firecrawl_agent_status_schema
							>;
							const known =
								job_metadata(
									'firecrawl_agent',
									job_id,
									next.status,
									false,
								).state !== 'unknown';
							if (
								known &&
								next.data !== undefined &&
								next.data !== null
							)
								last_evidence = next.data;
							last_observed =
								next.status !== 'completed' &&
								known &&
								next.data === undefined
									? { ...next, data: last_evidence }
									: next;
						},
					},
					firecrawl_agent_status_schema,
				);

				if (budget.signal.aborted) throw budget.signal.reason;
				return this.job_result(job_id, last_observed ?? poll_result);
			} catch (error) {
				if (accepted_job_id && budget.signal.aborted) {
					const wait_interrupted: 'timeout' | 'cancelled' =
						budget.signal.reason?.name === 'TimeoutError'
							? 'timeout'
							: 'cancelled';
					const partial = last_evidence !== undefined;
					const result: ProcessingResult = {
						content: partial
							? typeof last_evidence === 'string'
								? last_evidence
								: JSON.stringify(last_evidence)
							: JSON.stringify({
									job_id: accepted_job_id,
									status: 'unknown',
									wait_interrupted,
									message:
										'Local wait stopped; the remote job may still be running. Use firecrawl_agent action="status" or action="cancel" with this job_id, not a new start.',
								}),
						metadata: {
							job_id: accepted_job_id,
							status: 'unknown',
							wait_interrupted,
						},
						source_provider: this.name,
					};
					const job = {
						...job_metadata(
							'firecrawl_agent',
							accepted_job_id,
							'unknown',
							partial,
						),
						wait_interrupted,
					};
					set_response_metadata(result, last_observed, this.name);
					set_response_job(result, job);
					return result;
				}
				try {
					handle_provider_error(
						error,
						this.name,
						'run autonomous agent',
					);
				} catch (failure) {
					if (accepted_job_id && failure instanceof ProviderError) {
						failure.details = {
							...failure.details,
							job_id: accepted_job_id,
							recovery:
								'Use firecrawl_agent action="status" or action="cancel" with this job_id; do not start a new job.',
						};
						const prior_failure = get_job_failure(failure);
						if (
							!prior_failure ||
							(!prior_failure.result && last_evidence !== undefined)
						) {
							const partial = last_evidence !== undefined;
							const job = prior_failure
								? { ...prior_failure.job, partial }
								: job_metadata(
										'firecrawl_agent',
										accepted_job_id,
										'unknown',
										partial,
									);
							const result = partial
								? this.job_result(accepted_job_id, {
										...last_observed!,
										data: last_evidence,
										status: 'processing',
										success: true,
									})
								: undefined;
							set_response_metadata(
								failure,
								last_observed,
								this.name,
							);
							set_response_job(failure, job);
							set_job_failure(failure, job, result);
						}
					}
					throw failure;
				}
			} finally {
				budget.dispose();
			}
		};

		// The operation owns cancellation so an accepted ID survives it.
		// A generic retry/abort race would discard that recovery payload.
		return agent_request();
	}
}
