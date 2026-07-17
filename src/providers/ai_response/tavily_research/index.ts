import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { handle_provider_error, sanitize_query } from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

interface TavilyResearchStartResponse {
	status: string;
	request_id: string;
	input: string;
	model: string;
	response_time: number;
}

interface TavilyResearchPollResponse {
	status: string;
	request_id: string;
	response_time: number;
	content?: string;
	sources?: Array<{
		title?: string;
		url: string;
		content?: string;
		raw_content?: string;
	}>;
}

export class TavilyResearchProvider implements SearchProvider {
	name = 'tavily_research';
	description =
		'Deep multi-step research using Tavily Research API. Runs multiple searches from different angles, analyzes sources, and synthesizes a structured report with inline citations. Best for complex research queries requiring thorough analysis.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.ai_response.tavily_research.api_key,
			this.name,
		);

		const research_request = async () => {
			try {
				const base_url =
					config.ai_response.tavily_research.base_url;
				const timeout =
					config.ai_response.tavily_research.timeout;
				const deadline = Date.now() + timeout;

				const start_response =
					await http_json<TavilyResearchStartResponse>(
						this.name,
						`${base_url}/research`,
						{
							method: 'POST',
							headers: {
								Authorization: `Bearer ${api_key}`,
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								input: sanitize_query(params.query),
								model: 'auto',
							}),
							signal: AbortSignal.timeout(
								Math.min(30000, timeout),
							),
						},
					);

				if (!start_response.request_id) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'No request ID returned from research API',
						this.name,
					);
				}

				const request_id = start_response.request_id;
				const poll_interval = 5000;

				while (Date.now() < deadline) {
					const remaining_before_wait = deadline - Date.now();
					if (remaining_before_wait <= 0) {
						break;
					}

					await new Promise((resolve) =>
						setTimeout(
							resolve,
							Math.min(poll_interval, remaining_before_wait),
						),
					);

					let poll_result: TavilyResearchPollResponse;
					try {
						poll_result =
							await http_json<TavilyResearchPollResponse>(
								this.name,
								`${base_url}/research/${request_id}`,
								{
									method: 'GET',
									headers: {
										Authorization: `Bearer ${api_key}`,
									},
									signal: AbortSignal.timeout(
										Math.min(15000, deadline - Date.now()),
									),
								},
							);
					} catch (error) {
						if (
							error instanceof ProviderError &&
							(error.type === ErrorType.API_ERROR ||
								error.type === ErrorType.INVALID_INPUT)
						) {
							throw error;
						}
						continue;
					}

					if (poll_result.status === 'completed') {
						if (!poll_result.content) {
							throw new ProviderError(
								ErrorType.PROVIDER_ERROR,
								'Research completed but no content returned',
								this.name,
							);
						}

						const results: SearchResult[] = [
							{
								title: 'Research Report',
								url: '',
								snippet: poll_result.content,
								score: 1.0,
								source_provider: this.name,
								metadata: {
									type: 'research_report',
									request_id,
									response_time:
										poll_result.response_time,
									sources_count:
										poll_result.sources?.length || 0,
								},
							},
						];

						if (
							poll_result.sources &&
							poll_result.sources.length > 0
						) {
							const source_results =
								poll_result.sources.map(
									(source, index) => ({
										title:
											source.title || 'Source',
										url: source.url,
										snippet:
											source.content ||
											source.raw_content ||
											'Source reference',
										score: 0.9 - index * 0.05,
										source_provider: this.name,
										metadata: {
											type: 'source',
										},
									}),
								);
							results.push(...source_results);
						}

						if (params.limit && params.limit > 0) {
							return results.slice(0, params.limit);
						}

						return results;
					}

					if (
						poll_result.status === 'failed' ||
						poll_result.status === 'error'
					) {
						throw new ProviderError(
							ErrorType.PROVIDER_ERROR,
							`Research task failed${
								poll_result.content
									? `: ${poll_result.content}`
									: ''
							}`,
							this.name,
						);
					}
				}

				throw new ProviderError(
					ErrorType.PROVIDER_ERROR,
					'Research timed out — try a simpler query',
					this.name,
				);
			} catch (error) {
				handle_provider_error(
					error,
					this.name,
					'run deep research',
				);
			}
		};

		return retry_with_backoff(research_request);
	}
}
