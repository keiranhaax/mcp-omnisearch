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

interface ExaSearchRequest {
	query: string;
	type?: string;
	numResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	contents?: Record<string, unknown>;
	category?: string;
	userLocation?: string;
	outputSchema?: Record<string, unknown>;
	systemPrompt?: string;
}

interface ExaSearchResult {
	id?: string;
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string;
	text?: string;
	score?: number;
	highlights?: string[];
	summary?: string;
}

interface ExaSearchResponse {
	requestId?: string;
	autopromptString?: string;
	resolvedSearchType?: string;
	results?: ExaSearchResult[];
	output?: unknown;
	costDollars?: unknown;
}

const build_contents = (params: BaseSearchParams) => {
	const contents: Record<string, unknown> = params.contents
		? { ...params.contents }
		: { text: { maxCharacters: 3000 } };

	if (params.additional_queries?.length) {
		contents.additionalQueries = params.additional_queries;
	}

	return contents;
};

const build_search_body = (params: BaseSearchParams): ExaSearchRequest => {
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
	if (params.category) request_body.category = params.category;
	if (params.user_location) request_body.userLocation = params.user_location;
	if (params.output_schema) request_body.outputSchema = params.output_schema;
	if (params.system_prompt) request_body.systemPrompt = params.system_prompt;

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

				const data = await http_json<ExaSearchResponse>(
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

				return (data.results || []).map((result) => ({
					title: result.title || result.url || 'Untitled result',
					url: result.url || '',
					snippet:
						result.text || result.summary || 'No content available',
					score: result.score,
					source_provider: this.name,
					metadata: {
						id: result.id,
						author: result.author,
						publishedDate: result.publishedDate,
						highlights: result.highlights,
						requestId: data.requestId,
						...(data.autopromptString
							? { autopromptString: data.autopromptString }
							: {}),
						...(data.resolvedSearchType
							? { resolvedSearchType: data.resolvedSearchType }
							: {}),
						output: data.output,
						costDollars: data.costDollars,
					},
				}));
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

export const __private__ = {
	build_search_body,
};
