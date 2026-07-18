import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import {
	handle_provider_error,
	sanitize_query,
} from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

interface YouWebResult {
	title: string;
	url: string;
	description: string;
	snippets?: string[];
	thumbnail_url?: string;
	page_age?: string;
	authors?: string[];
	favicon_url?: string;
}

interface YouNewsResult {
	title: string;
	url: string;
	description: string;
	snippets?: string[];
	thumbnail_url?: string;
	page_age?: string;
	authors?: string[];
}

interface YouSearchResponse {
	results?: {
		web?: YouWebResult[];
		news?: YouNewsResult[];
	};
	metadata?: {
		query: string;
		count: number;
		offset: number;
	};
}

export class YouSearchProvider implements SearchProvider {
	name = 'you';
	description =
		'You.com web search with LLM-optimized snippets. Returns web + news results. Supports domain filtering, freshness, country targeting, and search operators (site:, filetype:, OR, -keyword, "exact phrase"). $100 free credit.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.you.api_key,
			this.name,
		);

		const you_params = params as BaseSearchParams & {
			you_offset?: number;
			you_freshness?: string;
			you_country?: string;
		};

		const search_request = async () => {
			try {
				const query_params = new URLSearchParams({
					query: sanitize_query(params.query),
				});

				if (params.limit) {
					query_params.set(
						'count',
						Math.min(params.limit, 100).toString(),
					);
				}
				if (you_params.you_offset !== undefined) {
					query_params.set(
						'offset',
						Math.min(you_params.you_offset, 9).toString(),
					);
				}
				if (you_params.you_freshness) {
					query_params.set('freshness', you_params.you_freshness);
				}
				if (you_params.you_country) {
					query_params.set('country', you_params.you_country);
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
					`${config.search.you.base_url}/v1/agents/search?${query_params}`,
					{
						method: 'GET',
						headers: {
							'X-API-Key': api_key,
							Accept: 'application/json',
						},
						signal: AbortSignal.timeout(config.search.you.timeout),
					},
				);

				const results: SearchResult[] = [];

				if (data.results?.web?.length) {
					for (const item of data.results.web) {
						results.push({
							title: item.title,
							url: item.url,
							snippet: item.snippets?.join(' ') || item.description,
							source_provider: this.name,
							metadata: {
								type: 'web',
								page_age: item.page_age,
								authors: item.authors,
								thumbnail_url: item.thumbnail_url,
							},
						});
					}
				}

				if (data.results?.news?.length) {
					for (const item of data.results.news) {
						results.push({
							title: item.title,
							url: item.url,
							snippet: item.snippets?.join(' ') || item.description,
							source_provider: this.name,
							metadata: {
								type: 'news',
								page_age: item.page_age,
								authors: item.authors,
								thumbnail_url: item.thumbnail_url,
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
