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
import { TavilyExtractProvider } from '../../providers/processing/tavily_extract/index.js';
import { config } from '../../config/env.js';
import {
	get_available_providers,
	initialize_web_extract,
	register_web_extract,
} from './web_extract.js';

const fetch_mock = vi.fn();

const previous_keys = {
	firecrawl: config.processing.firecrawl_scrape.api_key,
	tavily: config.processing.tavily_extract.api_key,
	exa: config.processing.exa_contents.api_key,
	exa_similar: config.processing.exa_similar.api_key,
};

const create_server = () => {
	const tools: Array<{ definition: any; handler: any }> = [];
	return {
		tools,
		server: {
			tool: (definition: any, handler: any) => {
				tools.push({ definition, handler });
			},
		},
	};
};

const get_provider_options = (schema: any): string[] =>
	schema.entries.provider.options as string[];

const get_mode_options = (schema: any): string[] =>
	schema.entries.mode.wrapped.options as string[];

const get_description = (schema_node: any): string => {
	if (!schema_node) return '';
	if (typeof schema_node.description === 'string') {
		return schema_node.description;
	}
	const pipe = schema_node.pipe || schema_node.wrapped?.pipe;
	if (Array.isArray(pipe)) {
		const desc = pipe.find(
			(item: any) =>
				item?.type === 'description' ||
				typeof item?.description === 'string',
		);
		if (desc?.description) return desc.description;
	}
	if (schema_node.wrapped) {
		return get_description(schema_node.wrapped);
	}
	return '';
};

describe('web_extract Firecrawl summarize', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_scrape.api_key = 'fc-test-key';
		config.processing.tavily_extract.api_key = undefined;
		config.processing.exa_contents.api_key = undefined;
		config.processing.exa_similar.api_key = undefined;
	});

	afterEach(() => {
		config.processing.firecrawl_scrape.api_key =
			previous_keys.firecrawl;
		config.processing.tavily_extract.api_key = previous_keys.tavily;
		config.processing.exa_contents.api_key = previous_keys.exa;
		config.processing.exa_similar.api_key = previous_keys.exa_similar;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('forwards the Tavily reranking query through provider options', async () => {
		config.processing.tavily_extract.api_key = 'tvly-test-key';
		const process = vi
			.spyOn(TavilyExtractProvider.prototype, 'process_content')
			.mockResolvedValue({
				content: 'chunks',
				metadata: {},
				source_provider: 'tavily_extract',
			});
		const { server, tools } = create_server();
		initialize_web_extract();
		register_web_extract(server as any);
		await tools[0].handler({
			provider: 'tavily',
			url: 'https://example.test',
			query: 'pricing details',
		});
		expect(process).toHaveBeenCalledWith(
			'https://example.test',
			undefined,
			{ query: 'pricing details' },
		);
	});

	it('advertises only supported Firecrawl formats with a convertible schema', async () => {
		const { server, tools } = create_server();
		initialize_web_extract();
		register_web_extract(server as any);
		const schema = tools[0].definition.schema;
		expect(
			v.safeParse(schema, {
				provider: 'firecrawl',
				url: 'https://example.test',
				firecrawl_options: { formats: ['unsupported-format'] },
			}).success,
		).toBe(false);
		expect(
			(await new ValibotJsonSchemaAdapter().toJsonSchema(schema))
				.type,
		).toBe('object');
	});

	it('registers firecrawl:summarize with only configured providers', () => {
		const { server, tools } = create_server();

		expect(initialize_web_extract()).toBe(true);
		register_web_extract(server as any);

		expect(get_available_providers()).toEqual(['firecrawl']);

		const tool = tools.find(
			(item) => item.definition.name === 'web_extract',
		)!;
		expect(tool.definition.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const providers = get_provider_options(tool.definition.schema);
		const modes = get_mode_options(tool.definition.schema);
		const mode_description = get_description(
			tool.definition.schema.entries.mode,
		);

		expect(providers).toEqual(['firecrawl']);
		expect(modes).toContain('summarize');
		expect(mode_description).toContain('summarize');
	});

	it('routes mode=summarize through Firecrawl scrape with formats:["summary"] and returns data.summary', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: {
						summary: 'Concise page summary from Firecrawl v2.',
						metadata: { title: 'Example Article' },
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const { server, tools } = create_server();
		initialize_web_extract();
		register_web_extract(server as any);

		const tool = tools.find(
			(item) => item.definition.name === 'web_extract',
		)!;
		const response = await tool.handler({
			url: 'https://example.com/long-article',
			provider: 'firecrawl',
			mode: 'summarize',
		});

		expect(response.isError).toBeUndefined();
		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			url: 'https://example.com/long-article',
			formats: ['summary'],
		});

		const result = JSON.parse(response.content[0].text);
		expect(result.content).toBe(
			'Concise page summary from Firecrawl v2.',
		);
		expect(result.metadata).toMatchObject({
			title: 'Example Article',
			successful_extractions: 1,
		});
	});
});
