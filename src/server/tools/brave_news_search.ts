import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import { handle_large_result } from '../../common/results.js';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import { BraveNewsSearchProvider } from '../../providers/search/brave_news/index.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { tool_descriptions } from './descriptions.js';

let provider: BraveNewsSearchProvider | null = null;

export const initialize_brave_news = (): boolean => {
	if (
		is_api_key_valid(config.search.brave_news.api_key, 'brave_news')
	) {
		provider = new BraveNewsSearchProvider();
		return true;
	}
	return false;
};

export const get_available = () => (provider ? ['brave_news'] : []);

export const register_brave_news_search = (
	server: McpServer<GenericSchema>,
) => {
	if (!provider) return;

	server.tool(
		{
			name: 'brave_news_search',
			description: tool_descriptions.brave_news_search,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.object({
				query: v.pipe(v.string(), v.description('News search query')),
				count: v.optional(
					v.pipe(
						v.number(),
						v.description('Number of results (1-50)'),
					),
				),
				offset: v.optional(
					v.pipe(
						v.number(),
						v.description('Page offset for pagination'),
					),
				),
				country: v.optional(
					v.pipe(v.string(), v.description('2-letter country code')),
				),
				search_lang: v.optional(
					v.pipe(v.string(), v.description('Search language code')),
				),
				safesearch: v.optional(
					v.pipe(
						v.picklist(['off', 'moderate', 'strict']),
						v.description('SafeSearch level'),
					),
				),
				freshness: v.optional(
					v.pipe(v.string(), v.description('Freshness filter')),
				),
				extra_snippets: v.optional(
					v.pipe(
						v.boolean(),
						v.description('Include additional excerpts per result'),
					),
				),
			}),
		},
		async ({
			query,
			count,
			offset,
			country,
			search_lang,
			safesearch,
			freshness,
			extra_snippets,
		}) => {
			try {
				const results = await provider!.search({
					query,
					count,
					offset,
					country,
					search_lang,
					safesearch,
					freshness,
					extra_snippets,
				});
				const safe_results = handle_large_result(
					results,
					'brave_news_search',
				);
				mark_provider_success('search', 'brave_news');
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(safe_results, null, 2),
						},
					],
				};
			} catch (error) {
				mark_provider_error('search', 'brave_news', error);
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
