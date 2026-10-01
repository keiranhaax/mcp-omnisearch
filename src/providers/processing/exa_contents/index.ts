import * as v from 'valibot';
import { is_gone_status } from '../../../common/archive_fallback.js';
import { provider_json_request } from '../../../common/provider_request.js';
import {
	sanitize_exa_control_metadata,
	sanitize_exa_statuses,
} from '../../../common/provider_sanitization.js';
import { set_response_metadata } from '../../../common/response_metadata.js';
import {
	ErrorType,
	ProcessingProvider,
	ProcessingResult,
	ProviderError,
} from '../../../common/types.js';
import {
	validate_api_key,
	validate_processing_urls,
} from '../../../common/validation.js';
import { config } from '../../../config/env.js';

interface ExaContentsRequest {
	// Exa now prefers 'urls'. 'ids' is deprecated but still supported.
	urls?: string[];
	ids?: string[];
	text?: boolean;
	highlights?: boolean;
	summary?: boolean;
}

const exa_contents_response_schema = v.object({
	results: v.array(
		v.object({
			id: v.optional(v.string()),
			title: v.nullish(v.string()),
			url: v.string(),
			text: v.nullish(v.string()),
			highlights: v.nullish(v.array(v.string())),
			summary: v.nullish(v.string()),
			publishedDate: v.nullish(v.string()),
			author: v.nullish(v.string()),
		}),
	),
	statuses: v.optional(
		v.array(
			v.object({
				id: v.string(),
				status: v.picklist(['success', 'error']),
				source: v.optional(v.unknown()),
				error: v.optional(v.unknown()),
			}),
		),
	),
	requestId: v.optional(v.unknown()),
	costDollars: v.optional(v.unknown()),
});

export class ExaContentsProvider implements ProcessingProvider {
	name = 'exa_contents';
	description = 'Extract full content from Exa search result IDs';

	async process_content(
		idsOrUrls: string | string[],
		extract_depth: 'basic' | 'advanced' = 'basic',
	): Promise<ProcessingResult> {
		const api_key = validate_api_key(
			config.processing.exa_contents.api_key,
			this.name,
		);

		const items = Array.isArray(idsOrUrls) ? idsOrUrls : [idsOrUrls];

		if (items.length === 0) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'At least one ID must be provided',
				this.name,
			);
		}

		// Exa accepts either all public URLs or all result IDs, not a mix.
		const looksLikeUrl = (value: string) => {
			try {
				new URL(value);
				return true;
			} catch {
				return false;
			}
		};
		const url_count = items.filter(looksLikeUrl).length;
		if (url_count > 0 && url_count !== items.length) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Do not mix Exa result IDs and URLs in one contents request',
				this.name,
			);
		}
		const allAreUrls = url_count === items.length;
		if (allAreUrls) validate_processing_urls(items, this.name);

		const request_body: ExaContentsRequest = {
			...(allAreUrls ? { urls: items } : { ids: items }),
			text: true,
			highlights: extract_depth === 'advanced',
			summary: extract_depth === 'advanced',
		};

		return provider_json_request(
			this.name,
			{
				url: `${config.processing.exa_contents.base_url}/contents`,
				method: 'POST',
				headers: {
					'x-api-key': api_key,
					Authorization: `Bearer ${api_key}`,
					'Content-Type': 'application/json',
				},
				body: request_body,
				timeout_ms: config.processing.exa_contents.timeout,
				schema: exa_contents_response_schema,
				operation: 'extract contents',
			},
			(data) => {
				const controls = sanitize_exa_control_metadata(data);
				const statuses = sanitize_exa_statuses(data.statuses);

				// Combine all content
				let combined_content = '';
				const raw_contents: Array<{ url: string; content: string }> =
					[];
				let total_word_count = 0;
				const failed_urls = new Set(
					(statuses ?? [])
						.filter((item) => item.status === 'error')
						.map((item) => item.id),
				);
				// Exa names the page itself gone with an HTTP 404/410 or a
				// not-found tag; the opt-in archive fallback acts on these.
				const gone_urls = (statuses ?? [])
					.filter(
						(item) =>
							item.status === 'error' &&
							(is_gone_status(item.error?.httpStatusCode) ||
								/not_found|gone/i.test(item.error?.tag ?? '')),
					)
					.map((item) => item.id);

				for (const result of data.results) {
					if (
						failed_urls.has(result.id ?? result.url) ||
						failed_urls.has(result.url)
					)
						continue;
					const content =
						[
							result.text,
							result.summary,
							result.highlights
								?.filter((text) => text.trim())
								.join('\n\n'),
						].find((text) => text?.trim()) ?? '';
					if (!content) {
						failed_urls.add(result.id ?? result.url);
						continue;
					}
					const word_count = content
						.split(/\s+/)
						.filter(Boolean).length;
					total_word_count += word_count;

					// Add to combined content
					combined_content += `## ${result.title ?? result.url}\n\n`;
					if (result.author) {
						combined_content += `**Author:** ${result.author}\n`;
					}
					if (result.publishedDate) {
						combined_content += `**Published:** ${result.publishedDate}\n`;
					}
					combined_content += `**URL:** ${result.url}\n\n`;

					if (result.highlights && result.highlights.length > 0) {
						combined_content += `**Key Highlights:**\n`;
						for (const highlight of result.highlights) {
							combined_content += `- ${highlight}\n`;
						}
						combined_content += '\n';
					}

					if (result.summary && result.text) {
						combined_content += `**Summary:** ${result.summary}\n\n`;
						combined_content += `**Full Content:**\n${result.text}\n\n`;
					} else {
						combined_content += `${content}\n\n`;
					}

					combined_content += '---\n\n';

					// Add to raw contents
					raw_contents.push({
						url: result.url,
						content: content,
					});
				}

				if (raw_contents.length === 0) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'No content returned from Exa contents',
						this.name,
						{
							retryable: false,
							...(gone_urls.length ? { gone_urls } : {}),
						},
					);
				}

				const result: ProcessingResult = {
					content: combined_content,
					raw_contents,
					metadata: {
						title: `Content from ${raw_contents.length} Exa results`,
						word_count: total_word_count,
						urls_processed: items.length,
						successful_extractions: raw_contents.length,
						failed_urls: failed_urls.size
							? [...failed_urls]
							: undefined,
						...(gone_urls.length ? { gone_urls } : {}),
						statuses,
						extract_depth,
						requestId: controls.requestId,
					},
					source_provider: this.name,
				};
				set_response_metadata(result, controls, this.name);
				return result;
			},
		);
	}
}
