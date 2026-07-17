import { describe, expect, it } from 'vitest';
import { tool_descriptions } from './descriptions.js';

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
