import * as v from 'valibot';
import { parse_provider_response } from '../../../common/provider_response.js';
import { http_json } from '../../../common/http.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

const brave_answers_response_schema = v.object({
	choices: v.pipe(
		v.array(
			v.object({
				message: v.object({
					content: v.pipe(
						v.string(),
						v.check((value) => value.trim().length > 0),
					),
				}),
			}),
		),
		v.minLength(1),
	),
	model: v.optional(v.string()),
	usage: v.optional(
		v.object({
			completion_tokens: v.optional(v.number()),
			prompt_tokens: v.optional(v.number()),
			total_tokens: v.optional(v.number()),
		}),
	),
});

export class BraveAnswersProvider implements SearchProvider {
	name = 'brave_answers';
	description =
		'Brave AI-grounded answer (plain text, no inline citations in non-streaming mode). Uses real-time web search for grounding. For cited answers prefer search + extraction + local synthesis.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const search_request = async () => {
			const api_key = validate_api_key(
				config.ai_response.brave_answers.api_key,
				this.name,
			);

			try {
				const raw_response = await http_json(
					this.name,
					config.ai_response.brave_answers.base_url,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'X-Subscription-Token': api_key,
						},
						body: JSON.stringify({
							messages: [
								{
									role: 'user',
									content: params.query,
								},
							],
							model: 'brave',
							stream: false,
						}),
						signal: AbortSignal.timeout(
							config.ai_response.brave_answers.timeout,
						),
					},
				);

				const response = parse_provider_response(
					this.name,
					brave_answers_response_schema,
					raw_response,
				);
				const results: SearchResult[] = [];

				if (response.choices?.length > 0) {
					const answer = response.choices[0].message.content;

					results.push({
						title: 'Brave AI Answer',
						url: 'https://search.brave.com',
						snippet: answer,
						score: 1.0,
						source_provider: this.name,
						metadata: {
							model: response.model,
							usage: response.usage,
						},
					});
				}

				if (params.limit && params.limit > 0) {
					return results.slice(0, params.limit);
				}

				return results;
			} catch (error) {
				handle_provider_error(
					error,
					this.name,
					'fetch AI grounded answer',
				);
			}
		};

		return retry_with_backoff(search_request, {
			timeout_ms: config.ai_response.brave_answers.timeout,
		});
	}
}
