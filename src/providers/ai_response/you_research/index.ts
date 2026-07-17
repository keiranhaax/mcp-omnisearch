import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { handle_provider_error, sanitize_query } from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

interface YouResearchResponse {
	output?: {
		content: string;
		sources?: Array<{
			url: string;
			title?: string;
			snippets?: string[];
		}>;
	};
}

export type YouResearchEffort = 'lite' | 'standard' | 'deep' | 'exhaustive';

export class YouResearchProvider implements SearchProvider {
	name = 'you_research';
	description =
		'Deep research with cited synthesis via You.com Research API. Effort levels: lite (quick facts), standard (general), deep (thorough), exhaustive (comprehensive). Returns structured answer with inline citations and sources.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.ai_response.you_research.api_key,
			this.name,
		);

		const you_params = params as BaseSearchParams & {
			you_research_effort?: YouResearchEffort;
		};

		const research_request = async () => {
			try {
				const request_body: Record<string, any> = {
					input: sanitize_query(params.query),
				};

				if (you_params.you_research_effort) {
					request_body.research_effort =
						you_params.you_research_effort;
				}

				const data = await http_json<YouResearchResponse>(
					this.name,
					config.ai_response.you_research.base_url,
					{
						method: 'POST',
						headers: {
							'X-API-Key': api_key,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify(request_body),
						signal: AbortSignal.timeout(
							config.ai_response.you_research.timeout,
						),
					},
				);

				const results: SearchResult[] = [];

				if (data.output?.content) {
					results.push({
						title: 'You.com Research Report',
						url: 'https://you.com',
						snippet: data.output.content,
						score: 1.0,
						source_provider: this.name,
						metadata: {
							type: 'research_report',
							research_effort:
								you_params.you_research_effort || 'standard',
							sources_count:
								data.output.sources?.length || 0,
						},
					});
				}

				if (data.output?.sources?.length) {
					for (const [index, source] of data.output.sources.entries()) {
						results.push({
							title: source.title || 'Source',
							url: source.url,
							snippet:
								source.snippets?.join(' ') ||
								'Source reference',
							score: 0.9 - index * 0.05,
							source_provider: this.name,
							metadata: { type: 'source' },
						});
					}
				}

				if (params.limit && params.limit > 0) {
					return results.slice(0, params.limit);
				}

				return results;
			} catch (error) {
				handle_provider_error(
					error,
					this.name,
					'run research',
				);
			}
		};

		return retry_with_backoff(research_request);
	}
}
