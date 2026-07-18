import {
	make_firecrawl_request,
	poll_firecrawl_job,
} from '../../../common/firecrawl_utils.js';
import {
	ErrorType,
	ProcessingResult,
	ProviderError,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

interface FirecrawlAgentStartResponse {
	success: boolean;
	id?: string;
	error?: string;
}

interface FirecrawlAgentStatusResponse {
	success: boolean;
	status: string;
	data?: any;
	model?: string;
	creditsUsed?: number;
	expiresAt?: string;
	error?: string;
}

interface ResolvedAgentStart {
	start_url: string;
	start_response: FirecrawlAgentStartResponse;
}

const endpoint_missing_pattern =
	/(cannot (get|post|put|patch|delete)\s+\/|endpoint not found|route not found|unknown endpoint)/i;

const unique = (values: string[]) => {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		ordered.push(trimmed);
	}
	return ordered;
};

const derive_agent_candidates = (base_url: string): string[] => {
	const candidates = [base_url];
	const pairs: Array<[string, string]> = [
		['/v1/agent', '/v2/agent'],
		['/v2/agent', '/v1/agent'],
		['/v1/agent', '/v1/agents'],
		['/v2/agent', '/v2/agents'],
		['/v1/agents', '/v1/agent'],
		['/v2/agents', '/v2/agent'],
		['/v1/agents', '/v2/agent'],
		['/v2/agents', '/v1/agent'],
	];

	for (const [from, to] of pairs) {
		if (base_url.includes(from)) {
			candidates.push(base_url.replace(from, to));
		}
	}

	return unique(candidates);
};

const is_endpoint_candidate_error = (error: unknown): boolean => {
	if (!(error instanceof ProviderError)) return false;
	if (error.type === ErrorType.ENDPOINT_NOT_FOUND) return true;

	if (error.details && typeof error.details === 'object') {
		const status = (error.details as { status?: number }).status;
		if (status === 404 || status === 405) return true;
	}

	return endpoint_missing_pattern.test(error.message);
};

export class FirecrawlAgentProvider {
	name = 'firecrawl_agent';
	description =
		'Autonomous web data gathering agent powered by Firecrawl. Give it a natural language prompt and it autonomously searches, navigates, and extracts data from the web. No URLs required. Best for complex research tasks that require navigating multiple pages.';
	private resolved_start_url?: string;

	private async start_job_with_fallback(
		api_key: string,
		request_body: Record<string, any>,
	): Promise<ResolvedAgentStart> {
		const configured_base =
			config.processing.firecrawl_agent.base_url;
		const override_url =
			config.processing.firecrawl_agent.override_url || '';

		const candidates = unique([
			override_url,
			this.resolved_start_url || '',
			...derive_agent_candidates(configured_base),
		]);

		const attempted: Array<{ url: string; reason: string }> = [];

		for (const candidate of candidates) {
			try {
				const start_response =
					await make_firecrawl_request<FirecrawlAgentStartResponse>(
						this.name,
						candidate,
						api_key,
						request_body,
						config.processing.firecrawl_agent.timeout,
					);

				if (!start_response.success || !start_response.id) {
					const reason = start_response.error || 'No job ID returned';
					if (endpoint_missing_pattern.test(reason)) {
						attempted.push({ url: candidate, reason });
						continue;
					}
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						`Failed to start agent: ${reason}`,
						this.name,
						{ url: candidate },
					);
				}

				if (this.resolved_start_url !== candidate) {
					console.error(
						`firecrawl_agent start endpoint selected: ${candidate}`,
					);
				}
				this.resolved_start_url = candidate;
				return { start_url: candidate, start_response };
			} catch (error) {
				if (error instanceof ProviderError) {
					if (error.type === ErrorType.ENTITLEMENT_REQUIRED) {
						throw error;
					}
					if (is_endpoint_candidate_error(error)) {
						attempted.push({
							url: candidate,
							reason: error.message,
						});
						continue;
					}
				}
				throw error;
			}
		}

		throw new ProviderError(
			ErrorType.ENDPOINT_NOT_FOUND,
			`Unable to find a working Firecrawl agent endpoint after trying ${candidates.length} candidates`,
			this.name,
			{
				url: configured_base,
				candidates,
				attempted,
			},
		);
	}

	async run_agent(
		prompt: string,
		options?: {
			model?: 'spark-1-mini' | 'spark-1-pro';
			max_credits?: number;
		},
	): Promise<ProcessingResult> {
		if (!prompt || prompt.trim().length === 0) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Prompt is required for the agent',
				this.name,
			);
		}

		const agent_request = async () => {
			const api_key = validate_api_key(
				config.processing.firecrawl_agent.api_key,
				this.name,
			);

			try {
				const request_body: Record<string, any> = {
					prompt: prompt.trim(),
				};

				if (options?.model) {
					request_body.model = options.model;
				}

				if (options?.max_credits) {
					request_body.maxCredits = options.max_credits;
				}

				const { start_response, start_url } =
					await this.start_job_with_fallback(api_key, request_body);

				if (!start_response.success || !start_response.id) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						`Failed to start agent: ${start_response.error || 'No job ID returned'}`,
						this.name,
					);
				}

				const job_id = start_response.id;
				const status_url = `${start_url}/${job_id}`;

				const completed =
					await poll_firecrawl_job<FirecrawlAgentStatusResponse>({
						provider_name: this.name,
						status_url,
						api_key,
						max_attempts: 60,
						poll_interval: 3000,
						timeout: 30000,
					});

				if (completed.status !== 'completed') {
					const content = JSON.stringify(
						{
							message:
								'Firecrawl agent job is still processing. Retry the same request later for final output.',
							job_id,
							status: completed.status,
							model: completed.model,
							credits_used: completed.creditsUsed,
							expires_at: completed.expiresAt,
							status_url,
						},
						null,
						2,
					);
					const word_count = content
						.split(/\s+/)
						.filter(Boolean).length;

					return {
						content,
						metadata: {
							title: `Firecrawl agent job ${job_id}`,
							word_count,
						},
						source_provider: this.name,
					};
				}

				if (!completed.data) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'Agent completed but returned no data',
						this.name,
					);
				}

				const content =
					typeof completed.data === 'string'
						? completed.data
						: JSON.stringify(completed.data, null, 2);

				const word_count = content
					.split(/\s+/)
					.filter(Boolean).length;

				return {
					content,
					metadata: {
						title: `Firecrawl agent job ${job_id}`,
						word_count,
					},
					source_provider: this.name,
				};
			} catch (error) {
				handle_provider_error(
					error,
					this.name,
					'run autonomous agent',
				);
			}
		};

		return retry_with_backoff(agent_request, { max_retries: 0 });
	}
}
