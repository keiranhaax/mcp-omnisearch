import * as v from 'valibot';
import { parse_provider_response } from '../../../common/provider_response.js';
import { http_json } from '../../../common/http.js';
import {
	ErrorType,
	ProviderError,
	SearchResult,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

const brave_news_response_schema = v.object({
	results: v.array(
		v.object({
			title: v.optional(v.string()),
			url: v.pipe(
				v.string(),
				v.check((value) => value.trim().length > 0),
			),
			description: v.optional(v.string()),
			age: v.optional(v.string()),
			page_age: v.optional(v.string()),
			meta_url: v.optional(
				v.object({
					hostname: v.optional(v.string()),
					favicon: v.optional(v.string()),
				}),
			),
			thumbnail: v.optional(
				v.object({ src: v.optional(v.string()) }),
			),
			extra_snippets: v.optional(v.array(v.string())),
		}),
	),
});

export interface BraveNewsSearchOptions {
	query: string;
	count?: number;
	offset?: number;
	country?: string;
	search_lang?: string;
	safesearch?: 'off' | 'moderate' | 'strict';
	freshness?: string;
	extra_snippets?: boolean;
}

export class BraveNewsSearchProvider {
	name = 'brave_news_search';
	description =
		'Real-time news search from thousands of sources worldwide. Returns articles with titles, descriptions, publication dates, and thumbnails. Supports freshness filtering (pd=24h, pw=7d, pm=31d, py=365d), pagination (offset 0-9), and up to 50 results per request.';

	async search(
		options: BraveNewsSearchOptions,
	): Promise<SearchResult[]> {
		const max_count = 50;
		if (
			options.count !== undefined &&
			(!Number.isInteger(options.count) ||
				options.count < 1 ||
				options.count > max_count)
		) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				`count must be an integer between 1 and ${max_count}`,
				this.name,
			);
		}
		if (
			options.offset !== undefined &&
			(!Number.isInteger(options.offset) ||
				options.offset < 0 ||
				options.offset > 9)
		) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'offset must be an integer between 0 and 9',
				this.name,
			);
		}
		const news_request = async () => {
			const api_key = validate_api_key(
				config.search.brave_news.api_key,
				this.name,
			);

			try {
				const params = new URLSearchParams({
					q: options.query.trim(),
				});

				if (options.count) {
					params.set(
						'count',
						String(Math.min(Math.max(options.count, 1), 50)),
					);
				}

				if (options.offset !== undefined) {
					params.set(
						'offset',
						String(Math.min(Math.max(options.offset, 0), 9)),
					);
				}

				if (options.country) {
					params.set('country', options.country);
				}

				if (options.search_lang) {
					params.set('search_lang', options.search_lang);
				}

				if (options.safesearch) {
					params.set('safesearch', options.safesearch);
				}

				if (options.freshness) {
					params.set('freshness', options.freshness);
				}

				if (options.extra_snippets) {
					params.set('extra_snippets', 'true');
				}

				const raw_response = await http_json(
					this.name,
					`${config.search.brave.base_url}/news/search?${params}`,
					{
						method: 'GET',
						headers: {
							Accept: 'application/json',
							'X-Subscription-Token': api_key,
						},
						signal: AbortSignal.timeout(
							config.search.brave_news.timeout,
						),
					},
				);

				const response = parse_provider_response(
					this.name,
					brave_news_response_schema,
					raw_response,
				);
				const results = response.results;

				if (results.length === 0) {
					return [];
				}

				return results.map((result) => {
					const snippets_text = result.extra_snippets?.length
						? `\n\nAdditional excerpts:\n${result.extra_snippets.join('\n')}`
						: '';

					return {
						title: result.title || result.url,
						url: result.url,
						snippet: (result.description || '') + snippets_text,
						source_provider: this.name,
						metadata: {
							age: result.age,
							page_age: result.page_age,
							source_hostname: result.meta_url?.hostname,
							favicon: result.meta_url?.favicon,
							thumbnail: result.thumbnail?.src,
						},
					};
				});
			} catch (error) {
				handle_provider_error(error, this.name, 'search news');
			}
		};

		return retry_with_backoff(news_request, {
			timeout_ms: config.search.brave_news.timeout,
		});
	}
}
