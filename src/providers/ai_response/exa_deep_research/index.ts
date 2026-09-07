import * as v from 'valibot';
import { parse_provider_response } from '../../../common/provider_response.js';
import {
	sanitize_exa_control_metadata,
	sanitize_exa_grounding,
} from '../../../common/provider_sanitization.js';
import { set_response_metadata } from '../../../common/response_metadata.js';
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

const exa_deep_response_schema = v.object({
	requestId: v.optional(v.unknown()),
	output: v.object({
		content: v.pipe(
			v.unknown(),
			v.check(
				(value) =>
					value !== undefined &&
					value !== null &&
					(typeof value !== 'string' || value.trim().length > 0),
			),
		),
		grounding: v.optional(v.unknown()),
	}),
	results: v.optional(
		v.array(
			v.object({
				id: v.optional(v.string()),
				url: v.pipe(
					v.string(),
					v.check((value) => value.trim().length > 0),
				),
				title: v.nullish(v.string()),
				text: v.nullish(v.string()),
				summary: v.nullish(v.string()),
				publishedDate: v.nullish(v.string()),
				author: v.nullish(v.string()),
				score: v.nullish(v.number()),
			}),
		),
	),
	costDollars: v.optional(v.unknown()),
});

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

				const raw_data = await http_json(
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

				const data = parse_provider_response(
					this.name,
					exa_deep_response_schema,
					raw_data,
				);
				const controls = sanitize_exa_control_metadata(data);
				const answer = stringify_content(data.output.content);
				const results: SearchResult[] = [
					{
						title: 'Exa Deep Research',
						url: '',
						snippet: answer,
						score: 1.0,
						source_provider: this.name,
						metadata: {
							...controls,
							type: 'deep_research',
							grounding: sanitize_exa_grounding(
								data.output.grounding,
							),
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

				set_response_metadata(results, controls, this.name);
				return results;
			} catch (error) {
				handle_provider_error(error, this.name, 'run deep research');
			}
		};

		return retry_with_backoff(search_request, { max_retries: 0 });
	}
}
