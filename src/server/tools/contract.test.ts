import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { config } from '../../config/env.js';
import { tool_descriptions } from './descriptions.js';
import {
	initialize_web_search,
	register_web_search,
} from './web_search.js';

const max_description_length = 300;

const routing_contracts = [
	{ name: 'web_search', words: ['Search'] },
	{ name: 'github_search', words: ['Search', 'GitHub'] },
	{ name: 'ai_search', words: ['Answer', 'Research'] },
	{ name: 'web_extract', words: ['Extract', 'Process'] },
	{ name: 'brave_llm_context', words: ['context', 'RAG'] },
	{ name: 'brave_news_search', words: ['News', 'Search'] },
	{ name: 'brave_media_search', words: ['Media', 'Search'] },
	{ name: 'firecrawl_agent', words: ['Credit-sensitive'] },
	{ name: 'context_web_extract', words: ['Context.dev Web'] },
	{ name: 'context_brand_intel', words: ['Brand'] },
	{ name: 'context_styleguide', words: ['Design'] },
	{ name: 'context_classify', words: ['Business'] },
	{ name: 'context_transaction_identify', words: ['Transactions'] },
] as const;

const search_keys = ['tavily', 'brave', 'exa', 'you'] as const;
const original_search_keys = Object.fromEntries(
	search_keys.map((provider) => [
		provider,
		config.search[provider].api_key,
	]),
) as Record<(typeof search_keys)[number], string | undefined>;

afterEach(() => {
	for (const provider of search_keys) {
		config.search[provider].api_key = original_search_keys[provider];
	}
	initialize_web_search();
});

describe('Omnisearch tool descriptions', () => {
	it('keeps descriptions concise and single-line', () => {
		for (const [name, description] of Object.entries(
			tool_descriptions,
		)) {
			expect(description.trim()).toBe(description);
			expect(description).not.toContain('\n');
			if (description.length > max_description_length) {
				throw new Error(
					`${name} description is ${description.length} chars; keep it <= ${max_description_length}`,
				);
			}
		}
	});

	it('keeps explicit routing words for agent tool selection', () => {
		for (const contract of routing_contracts) {
			const description = tool_descriptions[contract.name];
			const normalized = description.toLowerCase();
			const has_routing_word = contract.words.some((word) =>
				normalized.includes(word.toLowerCase()),
			);

			expect(has_routing_word).toBe(true);
		}
	});
});

describe('Omnisearch public tool schemas', () => {
	it('advertises the current Exa publication category only', () => {
		for (const provider of search_keys) {
			config.search[provider].api_key =
				provider === 'exa' ? 'exa-contract-key' : undefined;
		}
		expect(initialize_web_search()).toBe(true);

		let schema: v.GenericSchema | undefined;
		register_web_search({
			tool: (definition: {
				name: string;
				schema: v.GenericSchema;
			}) => {
				if (definition.name === 'web_search')
					schema = definition.schema;
			},
		} as any);

		expect(schema).toBeDefined();
		const input = { query: 'academic work', provider: 'exa' };
		expect(
			v.safeParse(schema!, { ...input, category: 'publication' })
				.success,
		).toBe(true);
		for (const retired of [
			'research paper',
			'pdf',
			'github',
			'tweet',
		]) {
			expect(
				v.safeParse(schema!, { ...input, category: retired }).success,
			).toBe(false);
		}

		const entries = (schema as v.ObjectSchema<any, any>).entries;
		for (const retired_parameter of [
			'startCrawlDate',
			'endCrawlDate',
		]) {
			expect(entries).not.toHaveProperty(retired_parameter);
		}
	});
});
