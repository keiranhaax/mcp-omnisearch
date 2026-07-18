import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import { handle_large_result } from '../../common/results.js';
import {
	ErrorType,
	ProviderError,
	SearchProvider,
} from '../../common/types.js';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { tool_descriptions } from './descriptions.js';

// Concrete provider imports
import { ExaAnswerProvider } from '../../providers/ai_response/exa_answer/index.js';
import { ExaDeepResearchProvider } from '../../providers/ai_response/exa_deep_research/index.js';
import { LinkupProvider } from '../../providers/ai_response/linkup/index.js';
import { BraveAnswersProvider } from '../../providers/ai_response/brave_answers/index.js';
import { TavilyResearchProvider } from '../../providers/ai_response/tavily_research/index.js';
import { YouResearchProvider } from '../../providers/ai_response/you_research/index.js';

export type AISearchProviderName =
	| 'exa_answer'
	| 'exa_deep_research'
	| 'linkup'
	| 'brave_answers'
	| 'tavily_research'
	| 'you_research';

const providers = new Map<string, SearchProvider>();

export const initialize_ai_search = (): boolean => {
	providers.clear();
	if (
		is_api_key_valid(
			config.ai_response.exa_answer.api_key,
			'exa_answer',
		)
	)
		providers.set('exa_answer', new ExaAnswerProvider());
	if (
		is_api_key_valid(
			config.ai_response.exa_deep_research.api_key,
			'exa_deep_research',
		)
	)
		providers.set('exa_deep_research', new ExaDeepResearchProvider());
	if (is_api_key_valid(config.ai_response.linkup.api_key, 'linkup'))
		providers.set('linkup', new LinkupProvider());
	if (
		is_api_key_valid(
			config.ai_response.brave_answers.api_key,
			'brave_answers',
		)
	)
		providers.set('brave_answers', new BraveAnswersProvider());
	if (
		is_api_key_valid(
			config.ai_response.tavily_research.api_key,
			'tavily_research',
		)
	)
		providers.set('tavily_research', new TavilyResearchProvider());
	if (
		is_api_key_valid(
			config.ai_response.you_research.api_key,
			'you_research',
		)
	)
		providers.set('you_research', new YouResearchProvider());

	return providers.size > 0;
};

export const get_available_providers = () =>
	Array.from(providers.keys());

export const register_ai_search = (
	server: McpServer<GenericSchema>,
) => {
	if (providers.size === 0) return;

	const provider_names = Array.from(
		providers.keys(),
	) as AISearchProviderName[];

	server.tool(
		{
			name: 'ai_search',
			description: tool_descriptions.ai_search,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			schema: v.object({
				query: v.pipe(
					v.string(),
					v.minLength(1),
					v.maxLength(10000),
					v.description('Question or search query'),
				),
				provider: v.pipe(
					v.picklist(provider_names),
					v.description('AI search provider to use'),
				),
				limit: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(50),
						v.description('Maximum number of results (default: 10)'),
					),
				),
				you_research_effort: v.optional(
					v.pipe(
						v.picklist(['lite', 'standard', 'deep', 'exhaustive']),
						v.description(
							'You.com research effort level. Only used when provider is you_research.',
						),
					),
				),
				output_schema: v.optional(
					v.pipe(
						v.record(v.string(), v.any()),
						v.description(
							'JSON schema for structured output. Only used when provider is exa_deep_research.',
						),
					),
				),
				exa_deep_search_type: v.optional(
					v.pipe(
						v.picklist(['deep', 'deep-reasoning']),
						v.description(
							'Exa deep search mode. Only used when provider is exa_deep_research.',
						),
					),
				),
				system_prompt: v.optional(
					v.pipe(
						v.string(),
						v.maxLength(10000),
						v.description(
							'Exa system prompt. Only used when provider is exa_deep_research.',
						),
					),
				),
			}),
		},
		async ({
			query,
			provider,
			limit,
			you_research_effort,
			output_schema,
			exa_deep_search_type,
			system_prompt,
		}) => {
			try {
				const selected = providers.get(provider);
				if (!selected) {
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						`Provider "${provider}" is not available. Available: ${Array.from(providers.keys()).join(', ')}`,
						'ai_search',
					);
				}

				const results = await selected.search({
					query,
					limit,
					you_research_effort,
					output_schema,
					search_type: exa_deep_search_type,
					system_prompt,
				} as any);
				const safe_results = handle_large_result(
					results,
					'ai_search',
				);
				mark_provider_success('ai_response', provider);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(safe_results, null, 2),
						},
					],
				};
			} catch (error) {
				mark_provider_error('ai_response', provider, error);
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
