import {
	handle_provider_error,
	sanitize_query,
} from '../../../common/errors.js';
import * as v from 'valibot';
import { parse_provider_response } from '../../../common/provider_response.js';
import { http_json } from '../../../common/http.js';
import { retry_with_backoff } from '../../../common/retry.js';
import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

const you_result_schema = v.object({
	title: v.string(),
	url: v.string(),
	description: v.optional(v.string()),
	snippets: v.optional(v.array(v.string())),
	page_age: v.optional(v.string()),
	authors: v.optional(v.array(v.string())),
});
const you_response_schema = v.object({
	results: v.optional(
		v.object({
			web: v.optional(v.array(you_result_schema)),
			news: v.optional(v.array(you_result_schema)),
		}),
	),
});

export class YouSearchProvider implements SearchProvider {
	name = 'you';
	description =
		'You.com web search with LLM-optimized snippets. Returns web + news results. Supports domain filtering and search operators (site:, filetype:, OR, -keyword, "exact phrase"). Fast fallback when other search providers fail.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		if (
			params.limit !== undefined &&
			(!Number.isInteger(params.limit) ||
				params.limit < 1 ||
				params.limit > 100)
		) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'limit must be an integer between 1 and 100',
				this.name,
			);
		}
		const api_key = validate_api_key(
			config.search.you.api_key,
			this.name,
		);

		const search_request = async () => {
			try {
				const query_params = new URLSearchParams({
					query: sanitize_query(params.query),
				});

				if (params.limit) {
					query_params.set(
						'count',
						Math.min(params.limit, 20).toString(),
					);
				}
				if (params.include_domains?.length) {
					query_params.set(
						'include_domains',
						params.include_domains.join(','),
					);
				}
				if (params.exclude_domains?.length) {
					query_params.set(
						'exclude_domains',
						params.exclude_domains.join(','),
					);
				}

				const raw_data = await http_json(
					this.name,
					`${config.search.you.base_url}/v1/search?${query_params}`,
					{
						method: 'GET',
						headers: {
							Authorization: `Bearer ${api_key}`,
							Accept: 'application/json',
						},
						signal: AbortSignal.timeout(config.search.you.timeout),
					},
				);

				const data = parse_provider_response(
					this.name,
					you_response_schema,
					raw_data,
				);
				const results: SearchResult[] = [];

				for (const [type, items] of [
					['web', data.results?.web],
					['news', data.results?.news],
				] as const) {
					if (!items?.length) continue;
					for (const item of items) {
						results.push({
							title: item.title,
							url: item.url,
							snippet:
								item.snippets?.join(' ') || item.description || '',
							source_provider: this.name,
							metadata: {
								type,
								page_age: item.page_age,
								authors: item.authors,
							},
						});
					}
				}

				return results.slice(0, params.limit ?? 20);
			} catch (error) {
				handle_provider_error(
					error,
					this.name,
					'fetch search results',
				);
			}
		};

		return retry_with_backoff(search_request, {
			timeout_ms: config.search.you.timeout,
		});
	}
}
