import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import { handle_large_result } from '../../common/results.js';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import { BraveLlmContextProvider } from '../../providers/processing/brave_llm_context/index.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { tool_descriptions } from './descriptions.js';

let provider: BraveLlmContextProvider | null = null;

export const initialize_brave_llm_context = (): boolean => {
	if (
		is_api_key_valid(
			config.processing.brave_llm_context.api_key,
			'brave_llm_context',
		)
	) {
		provider = new BraveLlmContextProvider();
		return true;
	}
	return false;
};

export const get_available = () =>
	provider ? ['brave_llm_context'] : [];

export const register_brave_llm_context = (
	server: McpServer<GenericSchema>,
) => {
	if (!provider) return;

	server.tool(
		{
			name: 'brave_llm_context',
			description: tool_descriptions.brave_llm_context,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.object({
				query: v.pipe(
					v.string(),
					v.description(
						'Search query to get LLM-optimized context for.',
					),
				),
				count: v.optional(
					v.pipe(
						v.number(),
						v.description('Max search results to consider (1-50).'),
					),
				),
				maximum_number_of_urls: v.optional(
					v.pipe(
						v.number(),
						v.description(
							'Max different URLs to include in context.',
						),
					),
				),
				maximum_number_of_tokens: v.optional(
					v.pipe(
						v.number(),
						v.description(
							'Approx max tokens in context (max 32768).',
						),
					),
				),
				maximum_number_of_snippets: v.optional(
					v.pipe(
						v.number(),
						v.description(
							'Max snippets/chunks in context (max 256).',
						),
					),
				),
				context_threshold_mode: v.optional(
					v.pipe(
						v.picklist(['disabled', 'strict', 'lenient', 'balanced']),
						v.description('Threshold for including content'),
					),
				),
				maximum_number_of_tokens_per_url: v.optional(
					v.pipe(
						v.number(),
						v.description('Approx max tokens per URL (max 8192).'),
					),
				),
				maximum_number_of_snippets_per_url: v.optional(
					v.pipe(
						v.number(),
						v.description('Max snippets per URL (max 100).'),
					),
				),
				freshness: v.optional(
					v.pipe(v.string(), v.description('Freshness filter')),
				),
				country: v.optional(
					v.pipe(v.string(), v.description('Country code')),
				),
				search_lang: v.optional(
					v.pipe(v.string(), v.description('Search language code')),
				),
				enable_local: v.optional(
					v.pipe(
						v.boolean(),
						v.description('Enable Brave local recall explicitly.'),
					),
				),
				goggles: v.optional(
					v.pipe(
						v.union([v.string(), v.array(v.string())]),
						v.description(
							'Brave Goggles URL or inline definition for reranking.',
						),
					),
				),
				loc_lat: v.optional(v.number()),
				loc_long: v.optional(v.number()),
				loc_city: v.optional(v.string()),
				loc_state: v.optional(v.string()),
				loc_state_name: v.optional(v.string()),
				loc_country: v.optional(v.string()),
				loc_postal_code: v.optional(v.string()),
			}),
		},
		async ({
			query,
			count,
			maximum_number_of_urls,
			maximum_number_of_tokens,
			maximum_number_of_snippets,
			context_threshold_mode,
			maximum_number_of_tokens_per_url,
			maximum_number_of_snippets_per_url,
			freshness,
			country,
			search_lang,
			enable_local,
			goggles,
			loc_lat,
			loc_long,
			loc_city,
			loc_state,
			loc_state_name,
			loc_country,
			loc_postal_code,
		}) => {
			try {
				const result = await provider!.get_context(query, {
					count,
					maximum_number_of_urls,
					maximum_number_of_tokens,
					maximum_number_of_snippets,
					context_threshold_mode,
					maximum_number_of_tokens_per_url,
					maximum_number_of_snippets_per_url,
					freshness,
					country,
					search_lang,
					enable_local,
					goggles,
					loc_lat,
					loc_long,
					loc_city,
					loc_state,
					loc_state_name,
					loc_country,
					loc_postal_code,
				});
				const safe_result = handle_large_result(
					result,
					'brave_llm_context',
				);
				mark_provider_success('processing', 'brave_llm_context');
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(safe_result, null, 2),
						},
					],
				};
			} catch (error) {
				mark_provider_error('processing', 'brave_llm_context', error);
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
