import { afterEach, describe, expect, it } from 'vitest';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import * as v from 'valibot';
import { config } from '../../config/env.js';
import {
	initialize_web_search,
	register_web_search,
} from './web_search.js';

const original_keys = {
	tavily: config.search.tavily.api_key,
	exa: config.search.exa.api_key,
};
afterEach(() => {
	config.search.tavily.api_key = original_keys.tavily;
	config.search.exa.api_key = original_keys.exa;
	initialize_web_search();
});

describe('web_search provider-aware limits', () => {
	it('keeps discovery convertible and rejects excessive Tavily limits before networking', async () => {
		config.search.tavily.api_key = 'tavily-test-key';
		config.search.exa.api_key = 'exa-test-key';
		initialize_web_search();
		let schema: v.GenericSchema;
		let handler: (input: any) => Promise<any>;
		register_web_search({
			tool: (
				definition: { schema: v.GenericSchema },
				callback: typeof handler,
			) => {
				schema = definition.schema;
				handler = callback;
			},
		} as any);
		await expect(
			new ValibotJsonSchemaAdapter().toJsonSchema(schema!),
		).resolves.toMatchObject({ type: 'object' });
		expect(
			v.safeParse(schema!, {
				query: 'test',
				provider: 'tavily',
				limit: 20,
			}).success,
		).toBe(true);
		await expect(
			handler!({ query: 'test', provider: 'tavily', limit: 21 }),
		).resolves.toMatchObject({
			isError: true,
			content: [{ text: expect.stringContaining('at most 20') }],
		});
		expect(
			v.safeParse(schema!, {
				query: 'test',
				provider: 'exa',
				limit: 100,
			}).success,
		).toBe(true);
	});
});
