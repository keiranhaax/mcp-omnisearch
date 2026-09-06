import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import * as v from 'valibot';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { config } from '../../config/env.js';
import {
	initialize_brave_news,
	register_brave_news_search,
} from './brave_news_search.js';
import {
	initialize_brave_media,
	register_brave_media_search,
} from './brave_media_search.js';
import {
	initialize_github_search,
	register_github_search,
} from './github_search.js';
import {
	initialize_web_extract,
	register_web_extract,
} from './web_extract.js';
const keys = [
	config.search.brave_news,
	config.search.brave_media,
	config.search.github,
	config.processing.firecrawl_scrape,
	config.processing.exa_contents,
];
const previous = keys.map((item) => item.api_key);
beforeEach(() => {
	keys.forEach((item) => {
		item.api_key = 'contract-test-key';
	});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	keys.forEach((item, i) => {
		item.api_key = previous[i];
	});
	vi.restoreAllMocks();
});
const capture = (register: (server: any) => void) => {
	let definition: any;
	register({
		tool: (tool: any) => {
			definition = tool;
		},
	});
	return definition.schema as v.GenericSchema;
};
describe('numeric public tool contracts', () => {
	it.each([
		{
			initialize: initialize_brave_news,
			register: register_brave_news_search,
			input: { query: 'test' },
			field: 'count',
			min: 1,
			max: 50,
		},
		{
			initialize: initialize_brave_news,
			register: register_brave_news_search,
			input: { query: 'test' },
			field: 'offset',
			min: 0,
			max: 9,
		},
		{
			initialize: initialize_brave_media,
			register: register_brave_media_search,
			input: { query: 'test', type: 'images' },
			field: 'count',
			min: 1,
			max: 200,
		},
		{
			initialize: initialize_brave_media,
			register: register_brave_media_search,
			input: { query: 'test', type: 'videos' },
			field: 'count',
			min: 1,
			max: 200,
		},
		{
			initialize: initialize_brave_media,
			register: register_brave_media_search,
			input: { query: 'test', type: 'videos' },
			field: 'offset',
			min: 0,
			max: 9,
		},
		{
			initialize: initialize_github_search,
			register: register_github_search,
			input: { query: 'test' },
			field: 'limit',
			min: 1,
			max: 100,
		},
	])(
		'validates $field bounds for $input',
		async ({ initialize, register, input, field, min, max }) => {
			initialize();
			const schema = capture(register);
			for (const value of [NaN, Infinity, min - 1, max + 1, 1.5])
				expect(
					v.safeParse(schema, { ...input, [field]: value }).success,
				).toBe(false);
			for (const value of [min, max])
				expect(
					v.safeParse(schema, { ...input, [field]: value }).success,
				).toBe(true);
			expect(
				(await new ValibotJsonSchemaAdapter().toJsonSchema(schema))
					.type,
			).toBe('object');
		},
	);
	it('rejects unsafe cache-age integers in the scrape schema', () => {
		initialize_web_extract();
		const schema = capture(register_web_extract);
		for (const field of ['minAge', 'maxAge']) {
			expect(
				v.safeParse(schema, {
					provider: 'firecrawl',
					url: 'https://example.com',
					firecrawl_options: { [field]: Number.MAX_SAFE_INTEGER + 1 },
				}).success,
			).toBe(false);
		}
	});
});
