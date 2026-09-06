import * as v from 'valibot';
import { parse_provider_response } from '../../../common/provider_response.js';
import { http_json } from '../../../common/http.js';
import {
	ErrorType,
	ProviderError,
	SearchResult,
} from '../../../common/types.js';
import { handle_provider_error } from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

const brave_media_response_schema = v.object({
	results: v.array(
		v.object({
			title: v.optional(v.string()),
			url: v.pipe(
				v.string(),
				v.check((value) => value.trim().length > 0),
			),
			description: v.optional(v.string()),
			age: v.optional(v.string()),
			page_age: v.optional(v.string()),
			meta_url: v.optional(
				v.object({
					hostname: v.optional(v.string()),
					favicon: v.optional(v.string()),
				}),
			),
			thumbnail: v.optional(
				v.object({ src: v.optional(v.string()) }),
			),
			source: v.optional(v.string()),
			confidence: v.optional(v.string()),
			properties: v.optional(
				v.object({
					url: v.optional(v.string()),
					width: v.optional(v.number()),
					height: v.optional(v.number()),
				}),
			),
		}),
	),
});

export type BraveMediaType = 'images' | 'videos';

export interface BraveMediaSearchOptions {
	query: string;
	type: BraveMediaType;
	count?: number;
	offset?: number;
	country?: string;
	search_lang?: string;
	safesearch?: string;
	freshness?: string;
}

export class BraveMediaSearchProvider {
	name = 'brave_media_search';
	description =
		'Search for images and videos via Brave Search. Images: up to 200 results from billions of indexed images with confidence scoring. Videos: up to 50 results with thumbnails and metadata. Supports SafeSearch filtering and country/language targeting.';

	async search(
		options: BraveMediaSearchOptions,
	): Promise<SearchResult[]> {
		const max_count = options.type === 'images' ? 200 : 50;
		if (
			options.count !== undefined &&
			(!Number.isInteger(options.count) ||
				options.count < 1 ||
				options.count > max_count)
		) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				`count must be an integer between 1 and ${max_count}`,
				this.name,
			);
		}
		if (
			options.offset !== undefined &&
			(!Number.isInteger(options.offset) ||
				options.offset < 0 ||
				options.offset > 9)
		) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'offset must be an integer between 0 and 9',
				this.name,
			);
		}
		if (options.type === 'images') {
			return this.search_images(options);
		}
		return this.search_videos(options);
	}

	private async search_images(
		options: BraveMediaSearchOptions,
	): Promise<SearchResult[]> {
		const image_request = async () => {
			const api_key = validate_api_key(
				config.search.brave_media.api_key,
				this.name,
			);

			try {
				const params = new URLSearchParams({
					q: options.query.trim(),
				});

				if (options.count) {
					params.set(
						'count',
						String(Math.min(Math.max(options.count, 1), 200)),
					);
				}

				if (options.country) {
					params.set('country', options.country);
				}

				if (options.search_lang) {
					params.set('search_lang', options.search_lang);
				}

				if (options.safesearch) {
					const safe =
						options.safesearch === 'off' ? 'off' : 'strict';
					params.set('safesearch', safe);
				}

				const raw_response = await http_json(
					this.name,
					`${config.search.brave.base_url}/images/search?${params}`,
					{
						method: 'GET',
						headers: {
							Accept: 'application/json',
							'X-Subscription-Token': api_key,
						},
						signal: AbortSignal.timeout(
							config.search.brave_media.timeout,
						),
					},
				);

				const response = parse_provider_response(
					this.name,
					brave_media_response_schema,
					raw_response,
				);
				const results = response.results;

				return results.map((result) => ({
					title: result.title || 'Untitled Image',
					url: result.url || result.properties?.url || '',
					snippet: [
						result.source ? `Source: ${result.source}` : '',
						result.properties?.width && result.properties?.height
							? `Dimensions: ${result.properties.width}x${result.properties.height}`
							: '',
						result.confidence
							? `Relevance: ${result.confidence}`
							: '',
						result.properties?.url
							? `Image URL: ${result.properties.url}`
							: '',
						result.thumbnail?.src
							? `Thumbnail: ${result.thumbnail.src}`
							: '',
					]
						.filter(Boolean)
						.join('\n'),
					source_provider: this.name,
					metadata: {
						media_type: 'image',
						image_url: result.properties?.url,
						thumbnail_url: result.thumbnail?.src,
						width: result.properties?.width,
						height: result.properties?.height,
						confidence: result.confidence,
						source_hostname: result.meta_url?.hostname,
					},
				}));
			} catch (error) {
				handle_provider_error(error, this.name, 'search images');
			}
		};

		return retry_with_backoff(image_request, {
			timeout_ms: config.search.brave_media.timeout,
		});
	}

	private async search_videos(
		options: BraveMediaSearchOptions,
	): Promise<SearchResult[]> {
		const video_request = async () => {
			const api_key = validate_api_key(
				config.search.brave_media.api_key,
				this.name,
			);

			try {
				const params = new URLSearchParams({
					q: options.query.trim(),
				});

				if (options.count) {
					params.set(
						'count',
						String(Math.min(Math.max(options.count, 1), 50)),
					);
				}

				if (options.offset !== undefined) {
					params.set(
						'offset',
						String(Math.min(Math.max(options.offset, 0), 9)),
					);
				}

				if (options.country) {
					params.set('country', options.country);
				}

				if (options.search_lang) {
					params.set('search_lang', options.search_lang);
				}

				if (options.safesearch) {
					params.set('safesearch', options.safesearch);
				}

				if (options.freshness) {
					params.set('freshness', options.freshness);
				}

				const raw_response = await http_json(
					this.name,
					`${config.search.brave.base_url}/videos/search?${params}`,
					{
						method: 'GET',
						headers: {
							Accept: 'application/json',
							'X-Subscription-Token': api_key,
						},
						signal: AbortSignal.timeout(
							config.search.brave_media.timeout,
						),
					},
				);

				const response = parse_provider_response(
					this.name,
					brave_media_response_schema,
					raw_response,
				);
				const results = response.results;

				return results.map((result) => ({
					title: result.title || 'Untitled Video',
					url: result.url || '',
					snippet: [
						result.description || '',
						result.age ? `Published: ${result.age}` : '',
						result.meta_url?.hostname
							? `Source: ${result.meta_url.hostname}`
							: '',
					]
						.filter(Boolean)
						.join('\n'),
					source_provider: this.name,
					metadata: {
						media_type: 'video',
						age: result.age,
						page_age: result.page_age,
						source_hostname: result.meta_url?.hostname,
						thumbnail: result.thumbnail?.src,
					},
				}));
			} catch (error) {
				handle_provider_error(error, this.name, 'search videos');
			}
		};

		return retry_with_backoff(video_request, {
			timeout_ms: config.search.brave_media.timeout,
		});
	}
}
