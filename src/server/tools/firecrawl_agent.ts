import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import { ErrorType, ProviderError } from '../../common/types.js';
import { handle_large_result } from '../../common/results.js';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import { FirecrawlAgentProvider } from '../../providers/processing/firecrawl_agent/index.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { tool_descriptions } from './descriptions.js';

let provider: FirecrawlAgentProvider | null = null;

export const initialize_firecrawl_agent = (): boolean => {
	if (
		is_api_key_valid(
			config.processing.firecrawl_agent.api_key,
			'firecrawl_agent',
		)
	) {
		provider = new FirecrawlAgentProvider();
		return true;
	}
	return false;
};

export const get_available = () =>
	provider ? ['firecrawl_agent'] : [];

export const register_firecrawl_agent = (
	server: McpServer<GenericSchema>,
) => {
	if (!provider) return;

	server.tool(
		{
			name: 'firecrawl_agent',
			description: tool_descriptions.firecrawl_agent,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			schema: v.object({
				action: v.optional(
					v.picklist(['start', 'status', 'cancel']),
					'start',
				),
				job_id: v.optional(
					v.pipe(
						v.string(),
						v.uuid(),
						v.description(
							'Existing job ID for status/cancel; never starts a new job.',
						),
					),
				),
				prompt: v.optional(
					v.pipe(
						v.string(),
						v.minLength(1),
						v.maxLength(10000),
						v.description(
							'Natural-language prompt for a new paid job. Start returns immediately; use status with job_id to retrieve results.',
						),
					),
				),
				wait_for_completion: v.optional(
					v.pipe(
						v.boolean(),
						v.description(
							'Opt into a bounded wait on start. Default false; status never creates a new job.',
						),
					),
				),
				model: v.optional(
					v.pipe(
						v.picklist(['spark-2', 'spark-1-mini', 'spark-1-pro']),
						v.description('Firecrawl agent model'),
					),
				),
				max_credits: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(Number.MAX_SAFE_INTEGER),
						v.description(
							'Maximum credits to spend; positive integer. Defaults to 100, not the provider default.',
						),
					),
				),
			}),
		},
		async ({
			action = 'start',
			job_id,
			prompt,
			model,
			max_credits,
			wait_for_completion,
		}) => {
			try {
				const valid =
					action === 'start'
						? Boolean(prompt?.trim()) && job_id === undefined
						: (action === 'status' || action === 'cancel') &&
							Boolean(job_id) &&
							prompt === undefined &&
							model === undefined &&
							max_credits === undefined &&
							wait_for_completion === undefined;
				if (!valid)
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'start requires prompt only; status/cancel require job_id only',
						'firecrawl_agent',
					);
				const result =
					action === 'status' || action === 'cancel'
						? await provider!.manage_job(action, job_id!)
						: await provider!.run_agent(prompt!, {
								model,
								max_credits,
								wait_for_completion: wait_for_completion ?? false,
							});
				const safe_result = handle_large_result(
					result,
					'firecrawl_agent',
				);
				mark_provider_success('processing', 'firecrawl_agent');
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(safe_result, null, 2),
						},
					],
				};
			} catch (error) {
				mark_provider_error('processing', 'firecrawl_agent', error);
				const error_response = create_error_response(error as Error);
				const accepted_job_id =
					error instanceof ProviderError &&
					error.provider === 'firecrawl_agent' &&
					v.safeParse(
						v.pipe(v.string(), v.uuid()),
						error.details?.job_id,
					).success
						? (error.details.job_id as string)
						: undefined;
				const recovery = accepted_job_id
					? ` job_id=${accepted_job_id}. Use firecrawl_agent action="status" or action="cancel" with this job_id; do not start a new job.`
					: '';
				return {
					content: [
						{
							type: 'text' as const,
							text: error_response.error + recovery,
						},
					],
					isError: true,
				};
			}
		},
	);
};
