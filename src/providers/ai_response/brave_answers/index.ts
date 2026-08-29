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

interface BraveAnswersChoice {
	index: number;
	message: {
		role: string;
		content: string;
	};
	finish_reason: string;
}

interface BraveAnswersUsage {
	completion_tokens: number;
	prompt_tokens: number;
	total_tokens: number;
}

interface BraveAnswersResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: BraveAnswersChoice[];
	usage: BraveAnswersUsage;
}

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
				const response = await http_json<BraveAnswersResponse>(
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

		return retry_with_backoff(search_request);
	}
}
