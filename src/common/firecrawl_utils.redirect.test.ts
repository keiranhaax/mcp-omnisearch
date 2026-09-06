import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import * as v from 'valibot';
import { config } from '../config/env.js';
import { FirecrawlAgentProvider } from '../providers/processing/firecrawl_agent/index.js';
import {
	make_firecrawl_request,
	poll_firecrawl_job,
} from './firecrawl_utils.js';

const previous = { ...config.processing.firecrawl_agent };
const job_id = '12345678-1234-4123-8123-123456789abc';
const listen = async (server: Server) => {
	await new Promise<void>((resolve) =>
		server.listen(0, '127.0.0.1', resolve),
	);
	const address = server.address();
	if (!address || typeof address === 'string')
		throw new Error('Missing loopback address');
	return `http://127.0.0.1:${address.port}`;
};
const close = async (server: Server) => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
};

afterEach(() => {
	Object.assign(config.processing.firecrawl_agent, previous);
});

it.each(['create', 'private create', 'poll', 'status', 'cancel'])(
	'never follows a credential-bearing %s redirect',
	async (operation) => {
		const received: string[] = [];
		const destination = createServer((request, response) => {
			let body = '';
			request.on('data', (chunk) => (body += chunk));
			request.on('end', () => {
				received.push(body);
				response.end(
					JSON.stringify({
						success: true,
						id: job_id,
						status: 'completed',
						data: 'redirected',
					}),
				);
			});
		});
		const destination_url = await listen(destination);
		let source_requests = 0;
		const source = createServer((request, response) => {
			source_requests++;
			request.resume();
			response.writeHead(307, {
				location: `${destination_url}/outside`,
			});
			response.end();
		});
		try {
			const source_url = await listen(source);
			config.processing.firecrawl_agent.api_key = 'fc-test-key';
			config.processing.firecrawl_agent.override_url = `${source_url}/private/agent`;
			const provider = new FirecrawlAgentProvider();
			const schema = v.object({ status: v.optional(v.string()) });
			const pending =
				operation === 'create'
					? make_firecrawl_request(
							'firecrawl',
							`${source_url}/create`,
							'fc-test-key',
							{ prompt: 'private redirect sentinel' },
							2000,
							schema,
						)
					: operation === 'private create'
						? provider.run_agent('private redirect sentinel', {
								wait_for_completion: false,
							})
						: operation === 'poll'
							? poll_firecrawl_job(
									{
										provider_name: 'firecrawl',
										status_url: `${source_url}/poll`,
										api_key: 'fc-test-key',
										max_attempts: 1,
										poll_interval: 1,
										timeout: 2000,
									},
									schema,
								)
							: provider.manage_job(
									operation as 'status' | 'cancel',
									job_id,
								);
			const result = await pending.catch((error: unknown) => error);
			expect(received).toEqual([]);
			expect(source_requests).toBe(1);
			expect(result).toBeInstanceOf(Error);
		} finally {
			await Promise.all([close(source), close(destination)]);
		}
	},
);
