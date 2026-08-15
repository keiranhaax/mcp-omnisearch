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

interface ExaDeepResearchRequest {
	query: string;
	type: 'deep' | 'deep-reasoning';
	numResults?: number;
	outputSchema: Record<string, unknown>;
	systemPrompt?: string;
}

interface ExaDeepResearchResult {
	id?: string;
	title?: string;
	url?: string;
	text?: string;
	summary?: string;
	publishedDate?: string;
	author?: string;
	score?: number;
}

interface ExaDeepResearchResponse {
	requestId?: string;
	output?: {
		content?: unknown;
		grounding?: unknown;
	};
	results?: ExaDeepResearchResult[];
	costDollars?: unknown;
}

const default_output_schema = {
	type: 'text',
	description:
		'Return a concise synthesized research answer grounded in web sources.',
};

const stringify_content = (content: unknown) => {
	if (typeof content === 'string') return content;
	if (content === undefined || content === null) return '';
	return JSON.stringify(content, null, 2);
};

export class ExaDeepResearchProvider implements SearchProvider {
	name = 'exa_deep_research';
	description =
		'Deep research-style Exa Search using type="deep-reasoning". Use for thorough multi-source synthesis with grounding when exa_answer is too shallow.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.ai_response.exa_deep_research.api_key,
			this.name,
		);

		const search_request = async () => {
			try {
				const request_body: ExaDeepResearchRequest = {
					query: sanitize_query(params.query),
					type:
						params.search_type === 'deep' ? 'deep' : 'deep-reasoning',
					numResults: params.limit ?? 10,
					outputSchema: params.output_schema ?? default_output_schema,
				};

				if (params.system_prompt) {
					request_body.systemPrompt = params.system_prompt;
				}

				const data = await http_json<ExaDeepResearchResponse>(
					this.name,
					`${config.ai_response.exa_deep_research.base_url}/search`,
					{
						method: 'POST',
						headers: {
							'x-api-key': api_key,
							Authorization: `Bearer ${api_key}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify(request_body),
						signal: AbortSignal.timeout(
							config.ai_response.exa_deep_research.timeout,
						),
					},
				);

				const answer = stringify_content(data.output?.content);
				const results: SearchResult[] = [
					{
						title: 'Exa Deep Research',
						url: '',
						snippet: answer || 'No synthesized output returned',
						score: 1.0,
						source_provider: this.name,
						metadata: {
							requestId: data.requestId,
							type: 'deep_research',
							grounding: data.output?.grounding,
							costDollars: data.costDollars,
							results_count: data.results?.length ?? 0,
						},
					},
				];

				if (data.results?.length) {
					results.push(
						...data.results.map((result, index) => ({
							title: result.title || 'Source',
							url: result.url || '',
							snippet:
								result.text || result.summary || 'Source reference',
							score: result.score ?? 0.9 - index * 0.01,
							source_provider: this.name,
							metadata: {
								id: result.id,
								author: result.author,
								publishedDate: result.publishedDate,
								type: 'source',
							},
						})),
					);
				}

				return results;
			} catch (error) {
				handle_provider_error(error, this.name, 'run deep research');
			}
		};

		return retry_with_backoff(search_request, { max_retries: 0 });
	}
}
