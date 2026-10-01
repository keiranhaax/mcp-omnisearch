import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import {
	context_dev_get,
	context_dev_post,
	require_one,
} from '../../common/context_dev.js';
import { ErrorType, ProviderError } from '../../common/types.js';
import {
	is_api_key_valid,
	validate_processing_domain,
	validate_processing_urls,
} from '../../common/validation.js';
import { config } from '../../config/env.js';
import {
	define_legacy_tool,
	type ToolAnnotations,
} from './define_tool.js';
import { tool_descriptions } from './descriptions.js';

const bounded_integer = (max: number) =>
	v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(max));
const timeout_schema = v.optional(bounded_integer(60000), 60000);
const provider_name = 'context_dev';
const tool_names = [
	'context_web_extract',
	'context_brand_intel',
	'context_styleguide',
	'context_classify',
	'context_transaction_identify',
];

let enabled = false;

export const initialize_context_dev = (): boolean => {
	enabled = is_api_key_valid(
		config.search.context_dev.api_key,
		provider_name,
	);
	return enabled;
};

// Every tool shares one credential and one upstream API, so health,
// metrics, spend caps and cooldowns are keyed by the provider, like
// the other providers, rather than by tool name.
export const get_available = () => (enabled ? [provider_name] : []);

// Every Context.dev tool is a read-only lookup against the same API.
const read_only: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

const optional_query = (values: Record<string, unknown>) => {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && value !== null) out[key] = value;
	}
	return out;
};

const public_url = (url: string, tool_name: string) =>
	validate_processing_urls(url, tool_name)[0];

const register_context_web_extract = (
	server: McpServer<GenericSchema>,
) => {
	define_legacy_tool(
		server,
		{
			name: 'context_web_extract',
			description: tool_descriptions.context_web_extract,
			annotations: read_only,
			category: 'processing',
			provider: provider_name,
			schema: v.object({
				mode: v.picklist([
					'markdown',
					'html',
					'crawl_markdown',
					'sitemap',
					'images',
					'screenshot',
					'web_search',
				]),
				url: v.optional(v.string()),
				domain: v.optional(v.string()),
				query: v.optional(v.string()),
				limit: v.optional(bounded_integer(100), 10),
				timeoutMS: timeout_schema,
				maxAgeMs: v.optional(v.number()),
				scrape_markdown: v.optional(v.boolean()),
				includeDomains: v.optional(v.array(v.string())),
				excludeDomains: v.optional(v.array(v.string())),
				freshness: v.optional(
					v.picklist([
						'last_24_hours',
						'last_week',
						'last_month',
						'last_year',
					]),
				),
			}),
		},
		async ({
			mode,
			url,
			domain,
			query,
			limit,
			timeoutMS,
			maxAgeMs,
			scrape_markdown,
			includeDomains,
			excludeDomains,
			freshness,
		}) => {
			let result: unknown;
			if (domain !== undefined)
				validate_processing_domain(domain, 'context_web_extract');
			if (mode === 'markdown') {
				if (!url)
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'url is required',
						'context_web_extract',
					);
				result = await context_dev_get(
					'/web/scrape/markdown',
					optional_query({
						url: public_url(url, 'context_web_extract'),
						timeoutMS,
						maxAgeMs,
					}),
				);
			} else if (mode === 'html') {
				if (!url)
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'url is required',
						'context_web_extract',
					);
				result = await context_dev_get(
					'/web/scrape/html',
					optional_query({
						url: public_url(url, 'context_web_extract'),
						timeoutMS,
						maxAgeMs,
					}),
				);
			} else if (mode === 'images') {
				if (!url)
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'url is required',
						'context_web_extract',
					);
				result = await context_dev_get(
					'/web/scrape/images',
					optional_query({
						url: public_url(url, 'context_web_extract'),
						timeoutMS,
						maxAgeMs,
					}),
				);
			} else if (mode === 'crawl_markdown') {
				if (!url)
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'url is required',
						'context_web_extract',
					);
				result = await context_dev_post(
					'/web/crawl',
					optional_query({
						url: public_url(url, 'context_web_extract'),
						timeoutMS,
						maxAgeMs,
						maxPages: limit,
					}),
				);
			} else if (mode === 'sitemap') {
				if (!domain)
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'domain is required',
						'context_web_extract',
					);
				result = await context_dev_get(
					'/web/scrape/sitemap',
					optional_query({ domain, timeoutMS, maxLinks: limit }),
				);
			} else if (mode === 'screenshot') {
				require_one('context_web_extract', { domain, url });
				result = await context_dev_get(
					'/web/screenshot',
					optional_query({
						domain,
						directUrl: url
							? public_url(url, 'context_web_extract')
							: undefined,
						timeoutMS,
						maxAgeMs,
					}),
				);
			} else {
				if (!query)
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'query is required',
						'context_web_extract',
					);
				result = await context_dev_post(
					'/web/search',
					optional_query({
						query,
						includeDomains,
						excludeDomains,
						freshness,
						timeoutMS,
						markdownOptions: scrape_markdown
							? { enabled: true, maxAgeMs }
							: undefined,
					}),
				);
			}
			return result;
		},
	);
};

const register_context_brand_intel = (
	server: McpServer<GenericSchema>,
) => {
	define_legacy_tool(
		server,
		{
			name: 'context_brand_intel',
			description: tool_descriptions.context_brand_intel,
			annotations: read_only,
			category: 'processing',
			provider: provider_name,
			schema: v.object({
				lookup_type: v.picklist([
					'domain',
					'company_name',
					'email',
					'stock_ticker',
					'simplified_domain',
				]),
				value: v.string(),
				timeoutMS: timeout_schema,
				maxAgeMs: v.optional(v.number()),
			}),
		},
		async ({ lookup_type, value, timeoutMS, maxAgeMs }) => {
			if (
				lookup_type === 'domain' ||
				lookup_type === 'simplified_domain'
			)
				validate_processing_domain(value, 'context_brand_intel');
			const path =
				lookup_type === 'domain'
					? '/brand/retrieve'
					: lookup_type === 'company_name'
						? '/brand/retrieve-by-name'
						: lookup_type === 'email'
							? '/brand/retrieve-by-email'
							: lookup_type === 'stock_ticker'
								? '/brand/retrieve-by-ticker'
								: '/brand/retrieve-simplified';
			const key =
				lookup_type === 'company_name'
					? 'name'
					: lookup_type === 'email'
						? 'email'
						: lookup_type === 'stock_ticker'
							? 'ticker'
							: 'domain';
			return context_dev_get(
				path,
				optional_query({ [key]: value, timeoutMS, maxAgeMs }),
			);
		},
	);
};

const register_context_styleguide = (
	server: McpServer<GenericSchema>,
) => {
	define_legacy_tool(
		server,
		{
			name: 'context_styleguide',
			description: tool_descriptions.context_styleguide,
			annotations: read_only,
			category: 'processing',
			provider: provider_name,
			schema: v.object({
				domain: v.optional(v.string()),
				directUrl: v.optional(v.string()),
				include_fonts: v.optional(v.boolean()),
				timeoutMS: timeout_schema,
				maxAgeMs: v.optional(v.number()),
			}),
		},
		async ({
			domain,
			directUrl,
			include_fonts,
			timeoutMS,
			maxAgeMs,
		}) => {
			require_one('context_styleguide', { domain, directUrl });
			if (domain !== undefined)
				validate_processing_domain(domain, 'context_styleguide');
			const params = optional_query({
				domain,
				directUrl: directUrl
					? public_url(directUrl, 'context_styleguide')
					: undefined,
				timeoutMS,
				maxAgeMs,
			});
			// Both are independent paid lookups; issue them together.
			const [styleguide, fonts] = await Promise.all([
				context_dev_get('/web/styleguide', params),
				include_fonts
					? context_dev_get('/web/fonts', params)
					: Promise.resolve(undefined),
			]);
			return { styleguide, fonts };
		},
	);
};

const register_context_classify = (
	server: McpServer<GenericSchema>,
) => {
	define_legacy_tool(
		server,
		{
			name: 'context_classify',
			description: tool_descriptions.context_classify,
			annotations: read_only,
			category: 'processing',
			provider: provider_name,
			schema: v.object({
				taxonomy: v.picklist(['naics', 'sic', 'eic']),
				domain: v.optional(v.string()),
				name: v.optional(v.string()),
				sic_version: v.optional(
					v.picklist(['original_sic', 'latest_sec']),
				),
				minResults: v.optional(bounded_integer(20), 1),
				maxResults: v.optional(bounded_integer(20), 20),
				timeoutMS: timeout_schema,
			}),
		},
		async ({
			taxonomy,
			domain,
			name,
			sic_version,
			minResults,
			maxResults,
			timeoutMS,
		}) => {
			require_one('context_classify', { domain, name });
			if ((minResults ?? 1) > (maxResults ?? 20)) {
				throw new ProviderError(
					ErrorType.INVALID_INPUT,
					'minResults must not exceed maxResults',
					'context_classify',
				);
			}
			if (domain !== undefined)
				validate_processing_domain(domain, 'context_classify');
			const input = domain || name;
			const result =
				taxonomy === 'naics'
					? await context_dev_get(
							'/web/naics',
							optional_query({
								input,
								minResults,
								maxResults,
								timeoutMS,
							}),
						)
					: taxonomy === 'sic'
						? await context_dev_get(
								'/web/sic',
								optional_query({
									input,
									type: sic_version,
									minResults,
									maxResults,
									timeoutMS,
								}),
							)
						: await context_dev_get(
								domain
									? '/brand/retrieve'
									: '/brand/retrieve-by-name',
								optional_query(
									domain
										? { domain, timeoutMS }
										: { name, timeoutMS },
								),
							);
			return taxonomy === 'eic'
				? {
						taxonomy,
						result,
						eic: (result as any)?.brand?.industries?.eic,
					}
				: result;
		},
	);
};

const register_context_transaction_identify = (
	server: McpServer<GenericSchema>,
) => {
	define_legacy_tool(
		server,
		{
			name: 'context_transaction_identify',
			description: tool_descriptions.context_transaction_identify,
			annotations: read_only,
			category: 'processing',
			provider: provider_name,
			schema: v.object({
				transaction_info: v.string(),
				country_gl: v.optional(v.string()),
				mcc: v.optional(v.string()),
				timeoutMS: timeout_schema,
			}),
		},
		async ({ transaction_info, country_gl, mcc, timeoutMS }) =>
			context_dev_get(
				'/brand/transaction_identifier',
				optional_query({
					transaction_info,
					country_gl,
					mcc,
					timeoutMS,
				}),
			),
	);
};

export const register_context_dev_tools = (
	server: McpServer<GenericSchema>,
	allow: (name: string) => boolean = () => true,
) => {
	if (!enabled) return;
	if (allow('context_web_extract'))
		register_context_web_extract(server);
	if (allow('context_brand_intel'))
		register_context_brand_intel(server);
	if (allow('context_styleguide'))
		register_context_styleguide(server);
	if (allow('context_classify')) register_context_classify(server);
	if (allow('context_transaction_identify'))
		register_context_transaction_identify(server);
};
