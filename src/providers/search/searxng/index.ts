import * as v from 'valibot';
import { sanitize_query } from '../../../common/errors.js';
import { provider_json_request } from '../../../common/provider_request.js';
import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { config } from '../../../config/env.js';

/**
 * Self-hosted SearXNG metasearch. Off unless the operator sets
 * SEARXNG_URL; there is no credential and the instance reports no
 * usage, so only a spending cap of 0 or the request budget bounds it.
 * The instance must have its JSON output format enabled.
 */

const MAX_RESULTS = 50;

const searxng_result_schema = v.looseObject({
	url: v.string(),
	title: v.optional(v.string()),
	content: v.nullish(v.string()),
	engine: v.optional(v.string()),
	engines: v.optional(v.array(v.string())),
	score: v.optional(v.number()),
	category: v.optional(v.string()),
	publishedDate: v.nullish(v.string()),
});
const searxng_response_schema = v.looseObject({
	results: v.optional(v.array(searxng_result_schema)),
});

/**
 * The configured base URL, or undefined when SearXNG is off or the
 * setting is not an http(s) URL without credentials. The value itself
 * is never logged; the operator set it and can read it.
 */
export const searxng_base_url = (
	raw = config.search.searxng.base_url,
): string | undefined => {
	if (raw === undefined || raw.trim() === '') return undefined;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		console.warn(
			'SEARXNG_URL is not a valid URL; SearXNG is disabled',
		);
		return undefined;
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		console.warn(
			'SEARXNG_URL must be a plain http(s) origin or path without credentials, query or fragment; SearXNG is disabled',
		);
		return undefined;
	}
	return url.toString().replace(/\/+$/, '');
};

const host_matches = (hostname: string, domain: string) => {
	const wanted = domain.trim().toLowerCase().replace(/^\*\./, '');
	return (
		wanted.length > 0 &&
		(hostname === wanted || hostname.endsWith(`.${wanted}`))
	);
};

export class SearxngSearchProvider implements SearchProvider {
	name = 'searxng';
	description =
		'Self-hosted SearXNG metasearch over the engines the instance enables. No usage reporting; domain filters are applied locally after retrieval.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const base_url = searxng_base_url();
		if (!base_url)
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'SearXNG is not configured',
				this.name,
				{ retryable: false, public: true },
			);
		const limit = Math.min(
			Number.isInteger(params.limit) && params.limit! > 0
				? params.limit!
				: 10,
			MAX_RESULTS,
		);
		const query_params = new URLSearchParams({
			q: sanitize_query(params.query),
			format: 'json',
			pageno: '1',
		});
		const include = params.include_domains ?? [];
		const exclude = params.exclude_domains ?? [];
		return provider_json_request(
			this.name,
			{
				url: `${base_url}/search?${query_params}`,
				headers: { Accept: 'application/json' },
				timeout_ms: config.search.searxng.timeout,
				schema: searxng_response_schema,
				operation: 'fetch search results',
			},
			(data) => {
				const results: SearchResult[] = [];
				for (const item of data.results ?? []) {
					let hostname: string;
					try {
						hostname = new URL(item.url).hostname.toLowerCase();
					} catch {
						continue;
					}
					if (
						include.length &&
						!include.some((domain) => host_matches(hostname, domain))
					)
						continue;
					if (
						exclude.some((domain) => host_matches(hostname, domain))
					)
						continue;
					results.push({
						title: item.title?.trim() || item.url,
						url: item.url,
						snippet: item.content ?? '',
						...(typeof item.score === 'number'
							? { score: item.score }
							: {}),
						source_provider: this.name,
						metadata: {
							engines:
								item.engines ?? (item.engine ? [item.engine] : []),
							...(item.category ? { category: item.category } : {}),
							...(item.publishedDate
								? { published_date: item.publishedDate }
								: {}),
						},
					});
					if (results.length >= limit) break;
				}
				return results;
			},
		).catch((error: unknown) => {
			// SearXNG answers 403 when its JSON format is disabled; say so
			// instead of the generic entitlement text. Fixed text only.
			if (
				error instanceof ProviderError &&
				error.details?.status === 403
			)
				throw new ProviderError(
					ErrorType.PROVIDER_ERROR,
					'SearXNG refused JSON output; enable the json format in its search settings',
					this.name,
					{ ...error.details, retryable: false, public: true },
				);
			throw error;
		});
	}
}
