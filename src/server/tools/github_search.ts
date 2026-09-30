import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import { GitHubSearchProvider } from '../../providers/search/github/index.js';
import { define_legacy_tool } from './define_tool.js';
import { tool_descriptions } from './descriptions.js';

let provider: GitHubSearchProvider | undefined;

export const initialize_github_search = (): boolean => {
	if (is_api_key_valid(config.search.github.api_key, 'github')) {
		provider = new GitHubSearchProvider();
		return true;
	}
	return false;
};

export const get_available = () => (provider ? ['github'] : []);

export const register_github_search = (
	server: McpServer<GenericSchema>,
) => {
	if (!provider) return;

	define_legacy_tool(
		server,
		{
			name: 'github_search',
			description: tool_descriptions.github_search,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			category: 'search',
			provider: 'github',
			schema: v.object({
				query: v.pipe(v.string(), v.description('Search query')),
				search_type: v.optional(
					v.pipe(
						v.picklist(['code', 'repositories', 'users']),
						v.description('What to search for (default: code)'),
					),
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
				sort: v.optional(
					v.pipe(
						v.picklist(['stars', 'forks', 'updated']),
						v.description('Sort order (repositories only)'),
					),
				),
			}),
		},
		async ({ query, search_type = 'code', limit, sort }) => {
			switch (search_type) {
				case 'code':
					return provider!.search_code({ query, limit });
				case 'repositories':
					return provider!.search_repositories({
						query,
						limit,
						sort,
					} as any);
				case 'users':
					return provider!.search_users({ query, limit });
			}
		},
	);
};
