import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
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
				prompt: v.pipe(
					v.string(),
					v.description(
						'Natural-language prompt describing what data to gather from the web.',
					),
				),
				model: v.optional(
					v.pipe(
						v.picklist(['spark-1-mini', 'spark-1-pro']),
						v.description('Firecrawl agent model'),
					),
				),
				max_credits: v.optional(
					v.pipe(
						v.number(),
						v.description('Maximum credits to spend'),
					),
				),
			}),
		},
		async ({ prompt, model, max_credits }) => {
			try {
				const result = await provider!.run_agent(prompt, {
					model,
					max_credits,
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
				return {
					content: [
						{
							type: 'text' as const,
							text: error_response.error,
						},
					],
					isError: true,
				};
			}
		},
	);
};
