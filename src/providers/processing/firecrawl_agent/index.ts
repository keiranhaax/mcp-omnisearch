import * as v from 'valibot';
import {
	firecrawl_poll_status_schema,
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

const firecrawl_agent_start_schema = v.object({
	success: v.boolean(),
	id: v.optional(v.pipe(v.string(), v.uuid())),
	error: v.optional(v.string()),
});

const firecrawl_agent_status_schema = v.object({
	success: v.optional(v.boolean()),
	status: firecrawl_poll_status_schema,
	data: v.optional(v.unknown()),
	model: v.optional(v.string()),
	creditsUsed: v.optional(v.number()),
	expiresAt: v.optional(v.string()),
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
		const start_response = await make_firecrawl_request(
			this.name,
			start_url,
			api_key,
			request_body,
			config.processing.firecrawl_agent.timeout,
			firecrawl_agent_start_schema,
			signal,
		);
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
		if (
			status.success === false ||
			status.status === 'failed' ||
			status.status === 'error'
		) {
			throw new ProviderError(
				ErrorType.PROVIDER_ERROR,
				`Agent job ${job_id} failed`,
				this.name,
				{ retryable: false, job_id, status: status.status },
			);
		}
		const metadata = {
			job_id,
			status: status.status,
			model: status.model,
			structured_data: status.data,
			credits_used: status.creditsUsed,
			expires_at: status.expiresAt,
			title: `Firecrawl agent job ${job_id}`,
		};
		const content =
			status.status === 'completed'
				? typeof status.data === 'string'
					? status.data
					: JSON.stringify(status.data, null, 2)
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
		if (content === undefined)
			throw new ProviderError(
				ErrorType.PROVIDER_ERROR,
				'Agent completed but returned no data',
				this.name,
				{ retryable: false },
			);
		return {
			content,
			metadata: {
				...metadata,
				word_count: content.split(/\s+/).filter(Boolean).length,
			},
			source_provider: this.name,
		};
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
			handle_provider_error(error, this.name, 'manage agent job');
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
				if (options?.wait_for_completion === false)
					return this.job_result(job_id, { status: 'processing' });
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
					},
					firecrawl_agent_status_schema,
				);

				return this.job_result(job_id, poll_result);
			} catch (error) {
				if (accepted_job_id && budget.signal.aborted) {
					const wait_interrupted =
						budget.signal.reason?.name === 'TimeoutError'
							? 'timeout'
							: 'cancelled';
					return {
						content: JSON.stringify({
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
