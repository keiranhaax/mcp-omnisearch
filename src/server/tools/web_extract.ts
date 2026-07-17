import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import { handle_large_result } from '../../common/results.js';
import {
	ErrorType,
	ProcessingProvider,
	ProviderError,
} from '../../common/types.js';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { tool_descriptions } from './descriptions.js';

// Concrete provider imports
import { ExaContentsProvider } from '../../providers/processing/exa_contents/index.js';
import { ExaSimilarProvider } from '../../providers/processing/exa_similar/index.js';
import { FirecrawlActionsProvider } from '../../providers/processing/firecrawl_actions/index.js';
import { FirecrawlCrawlProvider } from '../../providers/processing/firecrawl_crawl/index.js';
import { FirecrawlExtractProvider } from '../../providers/processing/firecrawl_extract/index.js';
import { FirecrawlMapProvider } from '../../providers/processing/firecrawl_map/index.js';
import { FirecrawlScrapeProvider } from '../../providers/processing/firecrawl_scrape/index.js';
import { KagiSummarizerProvider } from '../../providers/processing/kagi_summarizer/index.js';
import { TavilyExtractProvider } from '../../providers/processing/tavily_extract/index.js';
import { FirecrawlSearchProvider } from '../../providers/processing/firecrawl_search/index.js';

export type WebExtractProvider =
	| 'tavily'
	| 'kagi'
	| 'firecrawl'
	| 'exa';

export type WebExtractMode =
	| 'extract'
	| 'summarize'
	| 'scrape'
	| 'crawl'
	| 'map'
	| 'actions'
	| 'search'
	| 'contents'
	| 'similar';

// Provider key combines provider + mode
type ProviderKey = string;

const providers = new Map<ProviderKey, ProcessingProvider>();

const make_key = (provider: string, mode: string): ProviderKey =>
	`${provider}:${mode}`;

export const initialize_web_extract = (): boolean => {
	// Tavily
	if (
		is_api_key_valid(
			config.processing.tavily_extract.api_key,
			'tavily_extract',
		)
	)
		providers.set(
			make_key('tavily', 'extract'),
			new TavilyExtractProvider(),
		);

	// Kagi
	if (
		is_api_key_valid(
			config.processing.kagi_summarizer.api_key,
			'kagi_summarizer',
		)
	)
		providers.set(
			make_key('kagi', 'summarize'),
			new KagiSummarizerProvider(),
		);

	// Firecrawl
	if (
		is_api_key_valid(
			config.processing.firecrawl_scrape.api_key,
			'firecrawl',
		)
	) {
		providers.set(
			make_key('firecrawl', 'scrape'),
			new FirecrawlScrapeProvider(),
		);
		providers.set(
			make_key('firecrawl', 'crawl'),
			new FirecrawlCrawlProvider(),
		);
		providers.set(
			make_key('firecrawl', 'map'),
			new FirecrawlMapProvider(),
		);
		providers.set(
			make_key('firecrawl', 'extract'),
			new FirecrawlExtractProvider(),
		);
		providers.set(
			make_key('firecrawl', 'actions'),
			new FirecrawlActionsProvider(),
		);
		providers.set(
			make_key('firecrawl', 'search'),
			new FirecrawlSearchProvider(),
		);
	}

	// Exa
	if (
		is_api_key_valid(config.processing.exa_contents.api_key, 'exa')
	) {
		providers.set(
			make_key('exa', 'contents'),
			new ExaContentsProvider(),
		);
		providers.set(
			make_key('exa', 'similar'),
			new ExaSimilarProvider(),
		);
	}

	return providers.size > 0;
};

export const get_available_providers = () => {
	const available = new Set<string>();
	for (const key of providers.keys()) {
		available.add(key.split(':')[0]);
	}
	return Array.from(available);
};

// Default modes per provider
const default_modes: Record<WebExtractProvider, WebExtractMode> = {
	tavily: 'extract',
	kagi: 'summarize',
	firecrawl: 'scrape',
	exa: 'contents',
};

// Valid modes per provider
const valid_modes: Record<WebExtractProvider, WebExtractMode[]> = {
	tavily: ['extract'],
	kagi: ['summarize'],
	firecrawl: [
		'scrape',
		'crawl',
		'map',
		'extract',
		'actions',
		'search',
	],
	exa: ['contents', 'similar'],
};

const firecrawl_format_schema = v.union([
	v.string(),
	v.record(v.string(), v.any()),
]);

const firecrawl_options_schema = v.object({
	formats: v.optional(
		v.pipe(
			v.array(firecrawl_format_schema),
			v.description(
				'Firecrawl scrape response formats. Defaults to markdown.',
			),
		),
	),
	question: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'Ask a focused extraction question during scrape.',
			),
		),
	),
	highlights_query: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'Return relevant page highlights for this query.',
			),
		),
	),
	lockdown: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Use Firecrawl lockdown/cache-only behavior when supported.',
			),
		),
	),
	maxAge: v.optional(
		v.pipe(
			v.number(),
			v.description('Maximum cache age in milliseconds.'),
		),
	),
	minAge: v.optional(
		v.pipe(
			v.number(),
			v.description('Minimum cache age in milliseconds.'),
		),
	),
	storeInCache: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Allow Firecrawl to store the scrape result in cache.',
			),
		),
	),
	zeroDataRetention: v.optional(
		v.pipe(
			v.boolean(),
			v.description('Request zero data retention where supported.'),
		),
	),
	redactPII: v.optional(
		v.pipe(
			v.boolean(),
			v.description('Redact personally identifiable information.'),
		),
	),
	onlyMainContent: v.optional(
		v.pipe(
			v.boolean(),
			v.description('Prefer main article or page content.'),
		),
	),
	onlyCleanContent: v.optional(
		v.pipe(
			v.boolean(),
			v.description('Return cleaned page content when supported.'),
		),
	),
	removeBase64Images: v.optional(
		v.pipe(
			v.boolean(),
			v.description('Remove base64 images to avoid huge payloads.'),
		),
	),
});

const firecrawl_search_options_schema = v.object({
	limit: v.optional(
		v.pipe(
			v.number(),
			v.description('Maximum Firecrawl search results.'),
		),
	),
	sources: v.optional(
		v.pipe(
			v.array(v.picklist(['web', 'images', 'news'])),
			v.description('Firecrawl search verticals. Defaults to web.'),
		),
	),
	categories: v.optional(
		v.pipe(
			v.array(v.picklist(['github', 'research', 'pdf'])),
			v.description(
				'Firecrawl search categories for narrowed retrieval.',
			),
		),
	),
	includeDomains: v.optional(
		v.pipe(
			v.array(v.string()),
			v.description('Only search these domains.'),
		),
	),
	excludeDomains: v.optional(
		v.pipe(
			v.array(v.string()),
			v.description('Exclude these domains from results.'),
		),
	),
	tbs: v.optional(
		v.pipe(
			v.string(),
			v.description('Firecrawl time filter string.'),
		),
	),
	location: v.optional(
		v.pipe(v.string(), v.description('Search location hint.')),
	),
	country: v.optional(
		v.pipe(v.string(), v.description('Search country code.')),
	),
	ignoreInvalidURLs: v.optional(
		v.pipe(
			v.boolean(),
			v.description('Skip invalid URLs in search results.'),
		),
	),
	scrapeOptions: v.optional(
		v.pipe(
			v.object({
				formats: v.optional(
					v.pipe(
						v.array(firecrawl_format_schema),
						v.description(
							'Formats to scrape for each Firecrawl search hit.',
						),
					),
				),
				onlyMainContent: v.optional(
					v.pipe(
						v.boolean(),
						v.description('Scrape only main content for each hit.'),
					),
				),
				redactPII: v.optional(
					v.pipe(
						v.boolean(),
						v.description(
							'Redact PII in scraped search-hit content.',
						),
					),
				),
			}),
			v.description(
				'Optional scrape settings applied to Firecrawl search results.',
			),
		),
	),
});

export const register_web_extract = (
	server: McpServer<GenericSchema>,
) => {
	if (providers.size === 0) return;

	const available = get_available_providers() as WebExtractProvider[];

	server.tool(
		{
			name: 'web_extract',
			description: tool_descriptions.web_extract,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.object({
				url: v.optional(
					v.pipe(
						v.union([v.string(), v.array(v.string())]),
						v.description(
							'URL or array of URLs to process. Required for all modes except firecrawl search.',
						),
					),
				),
				query: v.optional(
					v.pipe(
						v.string(),
						v.description(
							'Search query (required when mode=search with firecrawl). Also used by tavily extract for chunk reranking.',
						),
					),
				),
				provider: v.pipe(
					v.picklist(available),
					v.description(
						'Provider to use: Firecrawl for scrape/crawl/search/actions, Exa for contents/similar, Tavily for extraction, Kagi for summarize.',
					),
				),
				mode: v.optional(
					v.pipe(
						v.picklist([
							'extract',
							'summarize',
							'scrape',
							'crawl',
							'map',
							'actions',
							'search',
							'contents',
							'similar',
						]),
						v.description(
							'Provider mode. firecrawl supports scrape/crawl/map/extract/actions/search; exa supports contents/similar; tavily supports extract; kagi supports summarize. Defaults to provider default.',
						),
					),
				),
				extract_depth: v.optional(
					v.pipe(
						v.picklist(['basic', 'advanced']),
						v.description('Extraction depth (default: basic)'),
					),
				),
				firecrawl_options: v.optional(
					v.pipe(
						firecrawl_options_schema,
						v.description(
							'Firecrawl scrape-only options: question, highlights_query, lockdown, cache, zero-data-retention, PII redaction, and content-cleaning flags.',
						),
					),
				),
				firecrawl_search_options: v.optional(
					v.pipe(
						firecrawl_search_options_schema,
						v.description(
							'Firecrawl search-only options: sources, categories, domain filters, geo/time filters, and per-result scrape settings.',
						),
					),
				),
			}),
		},
		async ({
			url,
			query,
			provider,
			mode,
			extract_depth,
			firecrawl_options,
			firecrawl_search_options,
		}) => {
			try {
				const resolved_mode =
					mode || default_modes[provider as WebExtractProvider];

				// Validate mode for provider
				const allowed = valid_modes[provider as WebExtractProvider];
				if (allowed && !allowed.includes(resolved_mode)) {
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						`Mode "${resolved_mode}" is not valid for provider "${provider}". Valid modes: ${allowed.join(', ')}`,
						'web_extract',
					);
				}

				// For firecrawl search mode, use query instead of url
				const input =
					resolved_mode === 'search' ? query || '' : url || '';

				if (!input || (typeof input === 'string' && !input.trim())) {
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						resolved_mode === 'search'
							? 'Query is required for search mode'
							: 'URL is required',
						'web_extract',
					);
				}

				const key = make_key(provider, resolved_mode);
				const selected = providers.get(key);

				if (!selected) {
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						`Provider "${provider}" with mode "${resolved_mode}" is not available. Check your API keys.`,
						'web_extract',
					);
				}

				if (
					firecrawl_options &&
					(provider !== 'firecrawl' || resolved_mode !== 'scrape')
				) {
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'firecrawl_options can only be used with provider=firecrawl and mode=scrape',
						'web_extract',
					);
				}

				if (
					firecrawl_search_options &&
					(provider !== 'firecrawl' || resolved_mode !== 'search')
				) {
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'firecrawl_search_options can only be used with provider=firecrawl and mode=search',
						'web_extract',
					);
				}

				const provider_options =
					provider === 'firecrawl' && resolved_mode === 'scrape'
						? firecrawl_options
						: provider === 'firecrawl' && resolved_mode === 'search'
							? firecrawl_search_options
							: undefined;

				const result = await selected.process_content(
					input,
					extract_depth,
					provider_options,
				);
				const safe_result = handle_large_result(
					result,
					'web_extract',
				);
				mark_provider_success('processing', provider);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(safe_result, null, 2),
						},
					],
				};
			} catch (error) {
				mark_provider_error('processing', provider, error);
				const error_response = create_error_response(error as Error);
				return {
					content: [
						{
							type: 'text' as const,
							text: error_response.error,
						},
					],
					isError: true,
				};
			}
		},
	);
};
