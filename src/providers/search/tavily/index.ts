import * as v from 'valibot';
import {
	handle_provider_error,
	sanitize_query,
} from '../../../common/errors.js';
import { http_json } from '../../../common/http.js';
import { parse_provider_response } from '../../../common/provider_response.js';
import { set_response_metadata } from '../../../common/response_metadata.js';
import { retry_with_backoff } from '../../../common/retry.js';
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

export const tavily_search_controls_schema = v.object({
	search_depth: v.optional(
		v.pipe(
			v.picklist(['basic', 'advanced', 'fast', 'ultra-fast']),
			v.description(
				'Tavily only. Default basic; advanced uses more provider credits. No automatic depth selection.',
			),
		),
	),
	topic: v.optional(
		v.pipe(
			v.picklist(['general', 'news', 'finance']),
			v.description(
				'Tavily only. Default general; news/finance cannot use a mapped country operator.',
			),
		),
	),
	time_range: v.optional(
		v.pipe(
			v.picklist(['day', 'week', 'month', 'year']),
			v.description(
				'Tavily only. Relative recency; cannot combine with before:/after: date operators.',
			),
		),
	),
});

const tavily_search_response_schema = v.object({
	results: v.optional(
		v.array(
			v.object({
				title: v.string(),
				url: v.string(),
				content: v.string(),
				score: v.number(),
			}),
		),
	),
	// Optional diagnostics must not invalidate otherwise valid content.
	request_id: v.optional(v.unknown()),
	response_time: v.optional(v.unknown()),
	usage: v.optional(v.unknown()),
});

const normalize_tavily_date = (date: string) => {
	if (/^\d{4}$/.test(date)) return `${date}-01-01`;
	if (/^\d{4}-\d{2}$/.test(date)) return `${date}-01`;
	return date;
};

const tavily_country_aliases: Record<string, string> = {
	uk: 'united kingdom',
	us: 'united states',
	usa: 'united states',
};

const normalize_tavily_country = (location: string) => {
	const normalized = location.toLowerCase().replace(/-/g, ' ');
	return tavily_country_aliases[normalized] ?? normalized;
};

export class TavilySearchProvider implements SearchProvider {
	name = 'tavily';
	description =
		'Search the web using Tavily Search API. Best for factual queries requiring reliable sources and citations. Supports domain filtering through API parameters (include_domains/exclude_domains). Provides high-quality results for technical, scientific, and academic topics. Use when you need verified information with strong citation support.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		if (!v.safeParse(tavily_search_controls_schema, params).success) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Invalid Tavily search controls',
				this.name,
				{ retryable: false },
			);
		}
		const api_key = validate_api_key(
			config.search.tavily.api_key,
			this.name,
		);

		const parsed_query = parse_search_operators(params.query);
		const search_params = apply_search_operators(parsed_query);
		// Native API filters are global constraints. Do not hoist them out
		// of Boolean/grouped expressions, or collapse repeated scalars.
		const can_map =
			!parsed_query.operators.some((op) => op.type === 'boolean') &&
			!/[()]/.test(params.query);
		const mapped_types = parsed_query.operators
			.filter(
				(op) =>
					can_map &&
					(op.type === 'site' ||
						op.type === 'exclude_site' ||
						(['before', 'after', 'location'].includes(op.type) &&
							parsed_query.operators.filter(
								(other) => other.type === op.type,
							).length === 1)),
			)
			.map((op) => op.type);

		if (
			params.time_range !== undefined &&
			parsed_query.operators.some(
				(op) => op.type === 'before' || op.type === 'after',
			)
		) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Tavily time_range cannot be combined with before:/after: operators',
				this.name,
				{ retryable: false },
			);
		}
		if (
			params.topic !== undefined &&
			params.topic !== 'general' &&
			mapped_types.includes('location')
		) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Tavily country operators require topic=general',
				this.name,
				{ retryable: false },
			);
		}

		const search_request = async () => {
			try {
				// Merge operator-extracted domains with explicit params
				const include_domains = [
					...(params.include_domains ?? []),
					...(mapped_types.includes('site')
						? (search_params.include_domains ?? [])
						: []),
				];
				const exclude_domains = [
					...(params.exclude_domains ?? []),
					...(mapped_types.includes('exclude_site')
						? (search_params.exclude_domains ?? [])
						: []),
				];

				const request_body: Record<string, any> = {
					query: sanitize_query(
						build_query_with_operators(
							search_params,
							undefined,
							undefined,
							{ exclude_operators: mapped_types },
						),
					),
					max_results: Math.min(params.limit ?? 5, 20),
					include_domains:
						include_domains.length > 0 ? include_domains : [],
					exclude_domains:
						exclude_domains.length > 0 ? exclude_domains : [],
					search_depth: params.search_depth ?? 'basic',
					topic: params.topic ?? 'general',
					time_range: params.time_range,
				};

				// Map date operators to Tavily's start_date/end_date
				if (
					search_params.date_after &&
					mapped_types.includes('after')
				) {
					request_body.start_date = normalize_tavily_date(
						search_params.date_after,
					);
				}
				if (
					search_params.date_before &&
					mapped_types.includes('before')
				) {
					request_body.end_date = normalize_tavily_date(
						search_params.date_before,
					);
				}

				// Map exact phrases to Tavily's exact_match
				if (
					can_map &&
					search_params.exact_phrases &&
					search_params.exact_phrases.length > 0
				) {
					request_body.exact_match = true;
				}

				// Map location operator to Tavily's country param
				if (
					search_params.location &&
					mapped_types.includes('location')
				) {
					request_body.country = normalize_tavily_country(
						search_params.location,
					);
				}

				const raw_data = await http_json(
					this.name,
					`${config.search.tavily.base_url}/search`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${api_key}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify(request_body),
						signal: AbortSignal.timeout(config.search.tavily.timeout),
					},
				);
				const data = parse_provider_response(
					this.name,
					tavily_search_response_schema,
					raw_data,
				);

				const results = (data.results ?? []).map((result) => ({
					title: result.title,
					url: result.url,
					snippet: result.content,
					score: result.score,
					source_provider: this.name,
				}));
				set_response_metadata(results, data);
				return results;
			} catch (error) {
				handle_provider_error(
					error,
					this.name,
					'fetch search results',
				);
			}
		};

		return retry_with_backoff(search_request, {
			timeout_ms: config.search.tavily.timeout,
		});
	}
}
