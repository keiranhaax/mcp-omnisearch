import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import { run_with_request_context } from '../common/request_context.js';
import { validate_config } from '../config/env.js';
import { setup_handlers } from './handlers.js';
import {
	initialize_providers,
	register_tools,
} from './tools/index.js';

export const create_server = (identity: {
	name: string;
	version: string;
}) => {
	const server = new McpServer<GenericSchema>(
		{
			...identity,
			description: 'MCP server for integrating Omnisearch with LLMs',
		},
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: {
				tools: { listChanged: true },
				resources: { listChanged: true },
			},
		},
	);
	const receive = server.receive.bind(server);
	server.receive = (message, context) =>
		run_with_request_context(
			(context as { signal?: AbortSignal } | undefined)?.signal,
			() => receive(message, context),
		);

	validate_config();
	initialize_providers();
	register_tools(server);
	setup_handlers(server);
	return server;
};
