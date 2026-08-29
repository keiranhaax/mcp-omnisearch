import {
	handle_provider_error,
	sanitize_query,
} from '../../../common/errors.js';
import { http_json } from '../../../common/http.js';
import { retry_with_backoff } from '../../../common/retry.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

interface YouWebResult {
	title: string;
	url: string;
	description?: string;
	snippets?: string[];
	thumbnail_url?: string;
	page_age?: string;
	authors?: string[];
	favicon_url?: string;
}

interface YouSearchResponse {
	results?: {
		web?: YouWebResult[];
		news?: YouWebResult[];
	};
	metadata?: {
		query?: string;
		search_uuid?: string;
		latency?: number;
	};
}

export class YouSearchProvider implements SearchProvider {
	name = 'you';
	description =
		'You.com web search with LLM-optimized snippets. Returns web + news results. Supports domain filtering and search operators (site:, filetype:, OR, -keyword, "exact phrase"). Fast fallback when other search providers fail.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
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

				const data = await http_json<YouSearchResponse>(
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

				return results;
			} catch (error) {
				handle_provider_error(
					error,
					this.name,
					'fetch search results',
				);
			}
		};

		return retry_with_backoff(search_request);
	}
}
