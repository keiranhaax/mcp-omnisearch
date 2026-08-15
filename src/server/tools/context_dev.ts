import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import {
	context_dev_get,
	context_dev_post,
	require_one,
} from '../../common/context_dev.js';
import { handle_large_result } from '../../common/results.js';
import { ErrorType, ProviderError } from '../../common/types.js';
import {
	is_api_key_valid,
	validate_processing_urls,
} from '../../common/validation.js';
import { config } from '../../config/env.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { tool_descriptions } from './descriptions.js';

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

export const get_available = () => (enabled ? tool_names : []);

const response = (tool_name: string, result: unknown) => ({
	content: [
		{
			type: 'text' as const,
			text: JSON.stringify(
				handle_large_result(result, tool_name),
				null,
				2,
			),
		},
	],
});

const error_response = (tool_name: string, error: unknown) => {
	mark_provider_error('processing', tool_name, error);
	const body = create_error_response(error as Error);
	return {
		content: [{ type: 'text' as const, text: body.error }],
		isError: true,
	};
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
	server.tool(
		{
			name: 'context_web_extract',
			description: tool_descriptions.context_web_extract,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
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
				limit: v.optional(v.number()),
				timeoutMS: v.optional(v.number()),
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
			try {
				let result: unknown;
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
				mark_provider_success('processing', 'context_web_extract');
				return response('context_web_extract', result);
			} catch (error) {
				return error_response('context_web_extract', error);
			}
		},
	);
};

const register_context_brand_intel = (
	server: McpServer<GenericSchema>,
) => {
	server.tool(
		{
			name: 'context_brand_intel',
			description: tool_descriptions.context_brand_intel,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.object({
				lookup_type: v.picklist([
					'domain',
					'company_name',
					'email',
					'stock_ticker',
					'simplified_domain',
				]),
				value: v.string(),
				timeoutMS: v.optional(v.number()),
				maxAgeMs: v.optional(v.number()),
			}),
		},
		async ({ lookup_type, value, timeoutMS, maxAgeMs }) => {
			try {
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
				const result = await context_dev_get(
					path,
					optional_query({ [key]: value, timeoutMS, maxAgeMs }),
				);
				mark_provider_success('processing', 'context_brand_intel');
				return response('context_brand_intel', result);
			} catch (error) {
				return error_response('context_brand_intel', error);
			}
		},
	);
};

const register_context_styleguide = (
	server: McpServer<GenericSchema>,
) => {
	server.tool(
		{
			name: 'context_styleguide',
			description: tool_descriptions.context_styleguide,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.object({
				domain: v.optional(v.string()),
				directUrl: v.optional(v.string()),
				include_fonts: v.optional(v.boolean()),
				timeoutMS: v.optional(v.number()),
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
			try {
				require_one('context_styleguide', { domain, directUrl });
				const params = optional_query({
					domain,
					directUrl: directUrl
						? public_url(directUrl, 'context_styleguide')
						: undefined,
					timeoutMS,
					maxAgeMs,
				});
				const styleguide = await context_dev_get(
					'/web/styleguide',
					params,
				);
				const fonts = include_fonts
					? await context_dev_get('/web/fonts', params)
					: undefined;
				mark_provider_success('processing', 'context_styleguide');
				return response('context_styleguide', { styleguide, fonts });
			} catch (error) {
				return error_response('context_styleguide', error);
			}
		},
	);
};

const register_context_classify = (
	server: McpServer<GenericSchema>,
) => {
	server.tool(
		{
			name: 'context_classify',
			description: tool_descriptions.context_classify,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.object({
				taxonomy: v.picklist(['naics', 'sic', 'eic']),
				domain: v.optional(v.string()),
				name: v.optional(v.string()),
				sic_version: v.optional(
					v.picklist(['original_sic', 'latest_sec']),
				),
				minResults: v.optional(v.number()),
				maxResults: v.optional(v.number()),
				timeoutMS: v.optional(v.number()),
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
			try {
				require_one('context_classify', { domain, name });
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
				mark_provider_success('processing', 'context_classify');
				return response(
					'context_classify',
					taxonomy === 'eic'
						? {
								taxonomy,
								result,
								eic: (result as any)?.brand?.industries?.eic,
							}
						: result,
				);
			} catch (error) {
				return error_response('context_classify', error);
			}
		},
	);
};

const register_context_transaction_identify = (
	server: McpServer<GenericSchema>,
) => {
	server.tool(
		{
			name: 'context_transaction_identify',
			description: tool_descriptions.context_transaction_identify,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			schema: v.object({
				transaction_info: v.string(),
				country_gl: v.optional(v.string()),
				mcc: v.optional(v.string()),
				timeoutMS: v.optional(v.number()),
			}),
		},
		async ({ transaction_info, country_gl, mcc, timeoutMS }) => {
			try {
				const result = await context_dev_get(
					'/brand/transaction_identifier',
					optional_query({
						transaction_info,
						country_gl,
						mcc,
						timeoutMS,
					}),
				);
				mark_provider_success(
					'processing',
					'context_transaction_identify',
				);
				return response('context_transaction_identify', result);
			} catch (error) {
				return error_response('context_transaction_identify', error);
			}
		},
	);
};

export const register_context_dev_tools = (
	server: McpServer<GenericSchema>,
) => {
	if (!enabled) return;
	register_context_web_extract(server);
	register_context_brand_intel(server);
	register_context_styleguide(server);
	register_context_classify(server);
	register_context_transaction_identify(server);
};
