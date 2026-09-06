import * as v from 'valibot';
import { parse_provider_response } from '../../../common/provider_response.js';
import { http_json } from '../../../common/http.js';
import {
	combine_request_signal,
	with_abort_signal,
	throw_if_aborted,
} from '../../../common/request_context.js';
import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import {
	handle_provider_error,
	sanitize_query,
} from '../../../common/errors.js';
import { delay, is_retryable_error } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

const research_start_schema = v.object({
	status: v.picklist([
		'pending',
		'in_progress',
		'completed',
		'failed',
		'error',
	]),
	request_id: v.pipe(v.string(), v.minLength(1)),
});
const research_poll_schema = v.object({
	...research_start_schema.entries,
	response_time: v.optional(v.union([v.number(), v.string()])),
	content: v.optional(v.string()),
	sources: v.optional(
		v.array(
			v.object({
				title: v.optional(v.string()),
				url: v.string(),
				content: v.optional(v.string()),
				raw_content: v.optional(v.string()),
			}),
		),
	),
});

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
				const base_url = config.ai_response.tavily_research.base_url;
				const timeout = config.ai_response.tavily_research.timeout;
				const deadline = Date.now() + timeout;

				const start_data = await http_json(
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
							stream: false,
						}),
						signal: AbortSignal.any([
							signal,
							AbortSignal.timeout(Math.min(30000, timeout)),
						]),
					},
				);

				const start_response = parse_provider_response(
					this.name,
					research_start_schema,
					start_data,
				);

				const request_id = start_response.request_id;
				const poll_interval = 5000;

				while (Date.now() < deadline) {
					const remaining_before_wait = deadline - Date.now();
					if (remaining_before_wait <= 0) {
						break;
					}

					await delay(
						Math.min(poll_interval, remaining_before_wait),
						signal,
					);
					throw_if_aborted(signal);
					if (Date.now() >= deadline) break;

					let poll_result: v.InferOutput<typeof research_poll_schema>;
					try {
						const poll_data = await http_json(
							this.name,
							`${base_url}/research/${encodeURIComponent(request_id)}`,
							{
								method: 'GET',
								headers: {
									Authorization: `Bearer ${api_key}`,
								},
								signal: AbortSignal.any([
									signal,
									AbortSignal.timeout(
										Math.min(15000, deadline - Date.now()),
									),
								]),
							},
						);
						poll_result = parse_provider_response(
							this.name,
							research_poll_schema,
							poll_data,
						);
					} catch (error) {
						if (!is_retryable_error(error)) {
							throw error;
						}
						const reset_time =
							error instanceof ProviderError
								? error.details?.reset_time
								: undefined;
						if (
							reset_time instanceof Date &&
							Number.isFinite(reset_time.getTime())
						) {
							const wait = Math.max(
								0,
								reset_time.getTime() - Date.now(),
							);
							if (wait >= deadline - Date.now()) throw error;
							await delay(wait, signal);
						}
						continue;
					}

					if (poll_result.status === 'completed') {
						if (!poll_result.content) {
							throw new ProviderError(
								ErrorType.PROVIDER_ERROR,
								'Research completed but no content returned',
								this.name,
								{ retryable: false },
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
									response_time: poll_result.response_time,
									sources_count: poll_result.sources?.length || 0,
								},
							},
						];

						if (
							poll_result.sources &&
							poll_result.sources.length > 0
						) {
							const source_results = poll_result.sources.map(
								(source, index) => ({
									title: source.title || 'Source',
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
							'Research task failed',
							this.name,
							{ retryable: false },
						);
					}
				}

				throw new ProviderError(
					ErrorType.PROVIDER_ERROR,
					'Research timed out — try a simpler query',
					this.name,
					{ retryable: false },
				);
			} catch (error) {
				handle_provider_error(error, this.name, 'run deep research');
			}
		};

		const signal = combine_request_signal(
			AbortSignal.timeout(config.ai_response.tavily_research.timeout),
		)!;
		return with_abort_signal(research_request, signal);
	}
}
