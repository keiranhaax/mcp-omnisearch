import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import { available_providers } from './tools/index.js';
import {
	get_provider_health_snapshot,
	get_provider_health_summary,
} from './provider_health.js';

export const setup_handlers = (server: McpServer<GenericSchema>) => {
	// Provider Status Resource
	server.resource(
		{
			name: 'provider-status',
			description: 'Current status of all search providers',
			uri: 'omnisearch://providers/status',
		},
		async () => {
			const health_summary = get_provider_health_summary();
			return {
				contents: [
					{
						uri: 'omnisearch://providers/status',
						mimeType: 'application/json',
						text: JSON.stringify(
							{
								status:
									health_summary.degraded > 0
										? 'degraded'
										: 'operational',
								providers: {
									search: Array.from(available_providers.search),
									ai_response: Array.from(
										available_providers.ai_response,
									),
									processing: Array.from(
										available_providers.processing,
									),
								},
								provider_health: get_provider_health_snapshot(),
								health_summary,
								available_count: {
									search: available_providers.search.size,
									ai_response: available_providers.ai_response.size,
									processing: available_providers.processing.size,
									total:
										available_providers.search.size +
										available_providers.ai_response.size +
										available_providers.processing.size,
								},
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	// Provider Info Resource Template
	server.template(
		{
			name: 'provider-info',
			description: 'Registration and runtime health for a provider',
			uri: 'omnisearch://search/{provider}/info',
		},
		async (uri) => {
			// Handle provider info template
			const providerMatch = uri.match(
				/^omnisearch:\/\/search\/([^/]+)\/info$/,
			);
			if (providerMatch) {
				const providerName = providerMatch[1];

				const category = available_providers.search.has(providerName)
					? 'search'
					: available_providers.ai_response.has(providerName)
						? 'ai_response'
						: available_providers.processing.has(providerName)
							? 'processing'
							: undefined;

				if (!category) {
					throw new Error(
						`Provider not available: ${providerName} (missing API key)`,
					);
				}

				return {
					contents: [
						{
							uri,
							mimeType: 'application/json',
							text: JSON.stringify(
								{
									name: providerName,
									status: 'registered',
									category,
									runtime_health:
										get_provider_health_snapshot()[category][
											providerName
										],
								},
								null,
								2,
							),
						},
					],
				};
			}

			throw new Error(`Unknown resource URI: ${uri}`);
		},
	);
};
