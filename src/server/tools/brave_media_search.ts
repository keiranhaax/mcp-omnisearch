import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import { BraveMediaSearchProvider } from '../../providers/search/brave_media/index.js';
import { define_legacy_tool } from './define_tool.js';
import { tool_descriptions } from './descriptions.js';

let provider: BraveMediaSearchProvider | null = null;

export const initialize_brave_media = (): boolean => {
	if (
		is_api_key_valid(config.search.brave_media.api_key, 'brave_media')
	) {
		provider = new BraveMediaSearchProvider();
		return true;
	}
	return false;
};

export const get_available = () => (provider ? ['brave_media'] : []);

export const register_brave_media_search = (
	server: McpServer<GenericSchema>,
) => {
	if (!provider) return;

	define_legacy_tool(
		server,
		{
			name: 'brave_media_search',
			description: tool_descriptions.brave_media_search,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			category: 'search',
			provider: 'brave_media',
			schema: v.object({
				query: v.pipe(
					v.string(),
					v.description('Media search query'),
				),
				type: v.pipe(
					v.picklist(['images', 'videos']),
					v.description('Media type'),
				),
				count: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(200),
						v.description(
							'Number of results (images 1-200; videos 1-50)',
						),
					),
				),
				offset: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(0),
						v.maxValue(9),
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
					v.pipe(v.string(), v.description('SafeSearch level')),
				),
				freshness: v.optional(
					v.pipe(v.string(), v.description('Freshness filter')),
				),
			}),
		},
		async ({
			query,
			type,
			count,
			offset,
			country,
			search_lang,
			safesearch,
			freshness,
		}) =>
			provider!.search({
				query,
				type,
				count,
				offset,
				country,
				search_lang,
				safesearch,
				freshness,
			}),
	);
};
