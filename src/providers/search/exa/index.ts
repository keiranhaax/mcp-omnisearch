import * as v from 'valibot';
import {
	handle_provider_error,
	sanitize_query,
} from '../../../common/errors.js';
import { http_json } from '../../../common/http.js';
import { parse_provider_response } from '../../../common/provider_response.js';
import {
	sanitize_exa_control_metadata,
	sanitize_exa_output,
} from '../../../common/provider_sanitization.js';
import { set_response_metadata } from '../../../common/response_metadata.js';
import { retry_with_backoff } from '../../../common/retry.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

interface ExaSearchRequest {
	query: string;
	type?: string;
	numResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	contents?: Record<string, unknown>;
	additionalQueries?: string[];
	category?: string;
	userLocation?: string;
	outputSchema?: Record<string, unknown>;
	systemPrompt?: string;
}

const exa_search_response_schema = v.object({
	requestId: v.optional(v.unknown()),
	autopromptString: v.optional(v.unknown()),
	resolvedSearchType: v.optional(v.unknown()),
	searchType: v.optional(v.unknown()),
	results: v.optional(
		v.array(
			v.object({
				id: v.nullish(v.string()),
				title: v.nullish(v.string()),
				url: v.nullish(v.string()),
				publishedDate: v.nullish(v.string()),
				author: v.nullish(v.string()),
				text: v.nullish(v.string()),
				score: v.nullish(v.number()),
				highlights: v.nullish(v.array(v.string())),
				summary: v.nullish(v.string()),
			}),
		),
	),
	output: v.optional(v.unknown()),
	costDollars: v.optional(v.unknown()),
});

const build_contents = (params: BaseSearchParams) => {
	return params.contents
		? { ...params.contents }
		: { text: { maxCharacters: 1500 } };
};

const build_search_body = (
	params: BaseSearchParams,
): ExaSearchRequest => {
	const request_body: ExaSearchRequest = {
		query: sanitize_query(params.query),
		type: params.search_type ?? 'auto',
		numResults: params.limit ?? 10,
		contents: build_contents(params),
	};

	if (params.include_domains?.length)
		request_body.includeDomains = params.include_domains;
	if (params.exclude_domains?.length)
		request_body.excludeDomains = params.exclude_domains;
	if (params.additional_queries?.length)
		request_body.additionalQueries = params.additional_queries;
	if (params.category) request_body.category = params.category;
	if (params.user_location)
		request_body.userLocation = params.user_location;
	if (params.output_schema)
		request_body.outputSchema = params.output_schema;
	if (params.system_prompt)
		request_body.systemPrompt = params.system_prompt;

	return request_body;
};

export class ExaSearchProvider implements SearchProvider {
	name = 'exa';
	description =
		'AI-powered web search using Exa search modes, categories, content extraction, and optional synthesized structured outputs. Optimized for AI applications with semantic understanding and research capabilities.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.exa.api_key,
			this.name,
		);

		const search_request = async () => {
			try {
				const request_body = build_search_body(params);

				const raw_data = await http_json(
					this.name,
					`${config.search.exa.base_url}/search`,
					{
						method: 'POST',
						headers: {
							'x-api-key': api_key,
							Authorization: `Bearer ${api_key}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify(request_body),
						signal: AbortSignal.timeout(config.search.exa.timeout),
					},
				);
				const data = parse_provider_response(
					this.name,
					exa_search_response_schema,
					raw_data,
				);

				const controls = sanitize_exa_control_metadata(data);
				const output = sanitize_exa_output(data.output);
				const results: SearchResult[] = (data.results ?? []).map(
					(result) => ({
						title: result.title || result.url || 'Untitled result',
						url: result.url || '',
						snippet:
							result.text || result.summary || 'No content available',
						score: result.score ?? undefined,
						source_provider: this.name,
						metadata: {
							id: result.id,
							author: result.author,
							publishedDate: result.publishedDate,
							highlights: result.highlights,
							...controls,
							output,
						},
					}),
				);
				set_response_metadata(results, controls, this.name);
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
			timeout_ms: config.search.exa.timeout,
		});
	}
}

export const __private__ = {
	build_search_body,
};
