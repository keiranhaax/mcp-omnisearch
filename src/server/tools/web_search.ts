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
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { tool_descriptions } from './descriptions.js';

// Concrete provider imports
import { config } from '../../config/env.js';
import { BraveSearchProvider } from '../../providers/search/brave/index.js';
import { ExaSearchProvider } from '../../providers/search/exa/index.js';
import { TavilySearchProvider } from '../../providers/search/tavily/index.js';

export type WebSearchProviderName = 'tavily' | 'brave' | 'exa';

const providers = new Map<string, SearchProvider>();

export const initialize_web_search = (): boolean => {
	providers.clear();
	if (is_api_key_valid(config.search.tavily.api_key, 'tavily'))
		providers.set('tavily', new TavilySearchProvider());
	if (is_api_key_valid(config.search.brave.api_key, 'brave'))
		providers.set('brave', new BraveSearchProvider());
	if (is_api_key_valid(config.search.exa.api_key, 'exa'))
		providers.set('exa', new ExaSearchProvider());

	return providers.size > 0;
};

export const get_available_providers = () =>
	Array.from(providers.keys());

export const register_web_search = (
	server: McpServer<GenericSchema>,
) => {
	if (providers.size === 0) return;

	const provider_names = Array.from(
		providers.keys(),
	) as WebSearchProviderName[];

	server.tool(
		{
			name: 'web_search',
			description: tool_descriptions.web_search,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.object({
				query: v.pipe(
					v.string(),
					v.minLength(1),
					v.maxLength(5000),
					v.description('Search query'),
				),
				provider: v.pipe(
					v.picklist(provider_names),
					v.description('Search provider to use'),
				),
				limit: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(100),
						v.description('Maximum number of results (default: 10)'),
					),
				),
				include_domains: v.optional(
					v.pipe(
						v.array(v.pipe(v.string(), v.maxLength(253))),
						v.maxLength(50),
						v.description('Only return results from these domains'),
					),
				),
				exclude_domains: v.optional(
					v.pipe(
						v.array(v.pipe(v.string(), v.maxLength(253))),
						v.maxLength(50),
						v.description('Exclude results from these domains'),
					),
				),
				search_type: v.optional(
					v.pipe(
						v.picklist([
							'instant',
							'fast',
							'auto',
							'deep-lite',
							'deep',
							'deep-reasoning',
						]),
						v.description(
							'Exa search type. Only used when provider is exa.',
						),
					),
				),
				category: v.optional(
					v.pipe(
						v.picklist([
							'company',
							'people',
							'publication',
							'news',
							'personal site',
							'financial report',
						]),
						v.description(
							'Exa category filter. Only used when provider is exa.',
						),
					),
				),
				user_location: v.optional(
					v.pipe(
						v.string(),
						v.description(
							'Two-letter Exa user location country code, such as US.',
						),
					),
				),
				contents: v.optional(
					v.pipe(
						v.record(v.string(), v.any()),
						v.description(
							'Exa contents options. Only used when provider is exa.',
						),
					),
				),
				output_schema: v.optional(
					v.pipe(
						v.record(v.string(), v.any()),
						v.description(
							'Exa JSON output schema for synthesized output.',
						),
					),
				),
				system_prompt: v.optional(
					v.pipe(
						v.string(),
						v.maxLength(10000),
						v.description(
							'Exa system prompt for synthesized output.',
						),
					),
				),
				additional_queries: v.optional(
					v.pipe(
						v.array(v.pipe(v.string(), v.maxLength(2000))),
						v.maxLength(10),
						v.description(
							'Additional top-level Exa search queries for multi-query retrieval.',
						),
					),
				),
			}),
		},
		async ({
			query,
			provider,
			limit,
			include_domains,
			exclude_domains,
			search_type,
			category,
			user_location,
			contents,
			output_schema,
			system_prompt,
			additional_queries,
		}) => {
			try {
				const selected = providers.get(provider);
				if (!selected) {
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						`Provider "${provider}" is not available. Available: ${Array.from(providers.keys()).join(', ')}`,
						'web_search',
					);
				}

				const results = await selected.search({
					query,
					limit,
					include_domains,
					exclude_domains,
					search_type,
					category,
					user_location,
					contents,
					output_schema,
					system_prompt,
					additional_queries,
				});
				const safe_results = handle_large_result(
					results,
					'web_search',
				);
				mark_provider_success('search', provider);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(safe_results, null, 2),
						},
					],
				};
			} catch (error) {
				mark_provider_error('search', provider, error);
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
