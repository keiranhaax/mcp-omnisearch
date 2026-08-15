import { describe, expect, it } from 'vitest';
import { ErrorType, ProviderError } from '../common/types.js';
import { setup_handlers } from './handlers.js';
import {
	mark_provider_error,
	mark_provider_success,
	register_provider,
	reset_provider_health,
} from './provider_health.js';
import { available_providers } from './tools/index.js';

interface RegisteredResource {
	definition: { name: string; uri: string };
	handler: (...args: any[]) => Promise<any>;
}

const create_mock_server = () => {
	const resources: RegisteredResource[] = [];
	return {
		resources,
		server: {
			resource: (
				definition: RegisteredResource['definition'],
				handler: RegisteredResource['handler'],
			) => {
				resources.push({ definition, handler });
			},
		},
	};
};

const reset_available_providers = () => {
	available_providers.search.clear();
	available_providers.ai_response.clear();
	available_providers.processing.clear();
	reset_provider_health();
};

describe('setup_handlers', () => {
	it('registers provider status and provider info resources', async () => {
		reset_available_providers();
		available_providers.search.add('brave');
		available_providers.ai_response.add('linkup');
		available_providers.processing.add('firecrawl');
		register_provider('search', 'brave');
		register_provider('ai_response', 'linkup');
		register_provider('processing', 'firecrawl');

		const { resources, server } = create_mock_server();
		setup_handlers(server as any);

		expect(
			resources.map((resource) => resource.definition.name),
		).toEqual(['provider-status', 'provider-info']);

		const provider_status = resources.find(
			(resource) => resource.definition.name === 'provider-status',
		)!;
		const status_response = await provider_status.handler();
		const status_body = JSON.parse(status_response.contents[0].text);

		expect(status_body).toEqual({
			status: 'operational',
			providers: {
				search: ['brave'],
				ai_response: ['linkup'],
				processing: ['firecrawl'],
			},
			provider_health: {
				search: {
					brave: {
						category: 'search',
						provider: 'brave',
						registered: true,
						last_runtime_status: 'unknown',
						active_error: false,
					},
				},
				ai_response: {
					linkup: {
						category: 'ai_response',
						provider: 'linkup',
						registered: true,
						last_runtime_status: 'unknown',
						active_error: false,
					},
				},
				processing: {
					firecrawl: {
						category: 'processing',
						provider: 'firecrawl',
						registered: true,
						last_runtime_status: 'unknown',
						active_error: false,
					},
				},
			},
			health_summary: {
				ok: 0,
				unknown: 3,
				degraded: 0,
				total: 3,
			},
			available_count: {
				search: 1,
				ai_response: 1,
				processing: 1,
				total: 3,
			},
		});
	});

	it('returns accurate registration information without invented rate limits', async () => {
		reset_available_providers();
		available_providers.search.add('brave');
		register_provider('search', 'brave');

		const { resources, server } = create_mock_server();
		setup_handlers(server as any);

		const provider_info = resources.find(
			(resource) => resource.definition.name === 'provider-info',
		)!;
		const response = await provider_info.handler(
			'omnisearch://search/brave/info',
		);
		const body = JSON.parse(response.contents[0].text);

		expect(body).toEqual({
			name: 'brave',
			status: 'registered',
			category: 'search',
			runtime_health: {
				category: 'search',
				provider: 'brave',
				registered: true,
				last_runtime_status: 'unknown',
				active_error: false,
			},
		});
	});

	it('returns registration information for processing providers', async () => {
		reset_available_providers();
		available_providers.processing.add('firecrawl');
		register_provider('processing', 'firecrawl');
		const { resources, server } = create_mock_server();
		setup_handlers(server as any);
		const provider_info = resources.find(
			(resource) => resource.definition.name === 'provider-info',
		)!;
		const response = await provider_info.handler(
			'omnisearch://search/firecrawl/info',
		);
		const body = JSON.parse(response.contents[0].text);
		expect(body).toMatchObject({
			name: 'firecrawl',
			status: 'registered',
			category: 'processing',
		});
	});

	it('throws for unavailable providers and unknown URIs', async () => {
		reset_available_providers();

		const { resources, server } = create_mock_server();
		setup_handlers(server as any);

		const provider_info = resources.find(
			(resource) => resource.definition.name === 'provider-info',
		)!;

		await expect(
			provider_info.handler('omnisearch://search/missing/info'),
		).rejects.toThrow(
			'Provider not available: missing (missing API key)',
		);

		await expect(
			provider_info.handler('omnisearch://unknown/resource'),
		).rejects.toThrow(
			'Unknown resource URI: omnisearch://unknown/resource',
		);
	});

	it('reports degraded status when a provider has runtime failures', async () => {
		reset_available_providers();
		available_providers.search.add('test_provider');
		register_provider('search', 'test_provider');
		mark_provider_error(
			'search',
			'test_provider',
			new ProviderError(
				ErrorType.ENTITLEMENT_REQUIRED,
				'API key does not have access to this endpoint',
				'test_provider',
				{ url: 'https://api.example.com/v1/search' },
			),
		);

		const { resources, server } = create_mock_server();
		setup_handlers(server as any);

		const provider_status = resources.find(
			(resource) => resource.definition.name === 'provider-status',
		)!;
		const status_response = await provider_status.handler();
		const status_body = JSON.parse(status_response.contents[0].text);

		expect(status_body.status).toBe('degraded');
		expect(status_body.health_summary.degraded).toBe(1);
		expect(
			status_body.provider_health.search.test_provider
				.last_runtime_status,
		).toBe('entitlement_required');
		expect(
			status_body.provider_health.search.test_provider.active_error,
		).toBe(true);
	});

	it('does not count stale errors after a newer provider success', async () => {
		reset_available_providers();
		available_providers.ai_response.add('brave_answers');
		register_provider('ai_response', 'brave_answers');
		mark_provider_error(
			'ai_response',
			'brave_answers',
			new ProviderError(
				ErrorType.API_ERROR,
				'The operation was aborted due to timeout',
				'brave_answers',
			),
		);
		mark_provider_success('ai_response', 'brave_answers');

		const { resources, server } = create_mock_server();
		setup_handlers(server as any);

		const provider_status = resources.find(
			(resource) => resource.definition.name === 'provider-status',
		)!;
		const status_response = await provider_status.handler();
		const status_body = JSON.parse(status_response.contents[0].text);

		expect(status_body.status).toBe('operational');
		expect(status_body.health_summary).toMatchObject({
			ok: 1,
			degraded: 0,
			total: 1,
		});
		expect(
			status_body.provider_health.ai_response.brave_answers
				.active_error,
		).toBe(false);
		expect(
			status_body.provider_health.ai_response.brave_answers
				.last_error,
		).toBe('The operation was aborted due to timeout');
	});
});
