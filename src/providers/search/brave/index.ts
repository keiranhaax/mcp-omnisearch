import * as v from 'valibot';
import { provider_json_request } from '../../../common/provider_request.js';
import {
	apply_search_operators,
	build_query_with_operators,
	parse_search_operators,
} from '../../../common/search_operators.js';
import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

const brave_search_response_schema = v.object({
	web: v.optional(
		v.object({
			results: v.array(
				v.object({
					title: v.optional(v.string()),
					url: v.optional(v.string()),
					description: v.optional(v.string()),
				}),
			),
		}),
	),
});

export class BraveSearchProvider implements SearchProvider {
	name = 'brave';
	description =
		'Privacy-focused search with operators: site:, -site:, filetype:/ext:, intitle:, inurl:, inbody:, inpage:, lang:, loc:, before:, after:, +term, -term, "exact". Best for technical content and privacy-sensitive queries.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.brave.api_key,
			this.name,
		);

		// Parse search operators from the query
		const parsed_query = parse_search_operators(params.query);
		const search_params = apply_search_operators(parsed_query);

		// Build query with all operators using shared utility
		const query = build_query_with_operators(
			search_params,
			params.include_domains,
			params.exclude_domains,
		);

		// Brave API limits: 400 chars / 50 words per query, max 20 results
		if (query.length > 400 || query.split(/\s+/).length > 50) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Brave query exceeds API limits (400 characters / 50 words). Shorten the query.',
				this.name,
				{ retryable: false },
			);
		}

		const query_params = new URLSearchParams({
			q: query,
			count: Math.min(params.limit ?? 5, 20).toString(),
			result_filter: 'web',
			text_decorations: 'false',
		});

		return provider_json_request(
			this.name,
			{
				url: `${config.search.brave.base_url}/web/search?${query_params}`,
				headers: {
					Accept: 'application/json',
					'X-Subscription-Token': api_key,
				},
				timeout_ms: config.search.brave.timeout,
				schema: brave_search_response_schema,
				operation: 'fetch search results',
			},
			(data) =>
				(data.web?.results || [])
					.filter(
						(
							result,
						): result is typeof result & {
							url: string;
						} => typeof result.url === 'string',
					)
					.map((result) => ({
						title: result.title ?? result.url,
						url: result.url,
						snippet: result.description ?? '',
						source_provider: this.name,
					})),
		);
	}
}
