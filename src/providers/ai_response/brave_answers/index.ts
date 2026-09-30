import * as v from 'valibot';
import { provider_json_request } from '../../../common/provider_request.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
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
		const api_key = validate_api_key(
			config.ai_response.brave_answers.api_key,
			this.name,
		);

		return provider_json_request(
			this.name,
			{
				url: config.ai_response.brave_answers.base_url,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Subscription-Token': api_key,
				},
				body: {
					messages: [{ role: 'user', content: params.query }],
					model: 'brave',
					stream: false,
				},
				timeout_ms: config.ai_response.brave_answers.timeout,
				schema: brave_answers_response_schema,
				operation: 'fetch AI grounded answer',
			},
			(response) => {
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
			},
		);
	}
}
