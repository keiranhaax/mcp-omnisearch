import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import {
	register_provider,
	reset_provider_health,
} from '../provider_health.js';
import {
	get_available_providers as get_ai_providers,
	initialize_ai_search,
	register_ai_search,
} from './ai_search.js';
import {
	get_available as get_brave_llm_context_providers,
	initialize_brave_llm_context,
	register_brave_llm_context,
} from './brave_llm_context.js';
import {
	get_available as get_brave_media_providers,
	initialize_brave_media,
	register_brave_media_search,
} from './brave_media_search.js';
import {
	get_available as get_brave_news_providers,
	initialize_brave_news,
	register_brave_news_search,
} from './brave_news_search.js';
import {
	get_available as get_firecrawl_agent_providers,
	initialize_firecrawl_agent,
	register_firecrawl_agent,
} from './firecrawl_agent.js';
import {
	get_available as get_context_dev_providers,
	initialize_context_dev,
	register_context_dev_tools,
} from './context_dev.js';
import {
	get_available as get_github_providers,
	initialize_github_search,
	register_github_search,
} from './github_search.js';
import {
	get_available_providers as get_extract_providers,
	initialize_web_extract,
	register_web_extract,
} from './web_extract.js';
import {
	get_available_providers as get_search_providers,
	initialize_web_search,
	register_web_search,
} from './web_search.js';
import { register_result_read } from './result_read.js';

// Track available providers by category for the status resource
export const available_providers = {
	search: new Set<string>(),
	ai_response: new Set<string>(),
	processing: new Set<string>(),
};

export const initialize_providers = () => {
	reset_provider_health();
	available_providers.search.clear();
	available_providers.ai_response.clear();
	available_providers.processing.clear();

	if (initialize_web_search()) {
		for (const p of get_search_providers()) {
			available_providers.search.add(p);
			register_provider('search', p);
		}
	}

	if (initialize_github_search()) {
		for (const p of get_github_providers()) {
			available_providers.search.add(p);
			register_provider('search', p);
		}
	}

	if (initialize_ai_search()) {
		for (const p of get_ai_providers()) {
			available_providers.ai_response.add(p);
			register_provider('ai_response', p);
		}
	}

	if (initialize_web_extract()) {
		for (const p of get_extract_providers()) {
			available_providers.processing.add(p);
			register_provider('processing', p);
		}
	}

	if (initialize_brave_llm_context()) {
		for (const p of get_brave_llm_context_providers()) {
			available_providers.processing.add(p);
			register_provider('processing', p);
		}
	}

	if (initialize_brave_media()) {
		for (const p of get_brave_media_providers()) {
			available_providers.search.add(p);
			register_provider('search', p);
		}
	}

	if (initialize_brave_news()) {
		for (const p of get_brave_news_providers()) {
			available_providers.search.add(p);
			register_provider('search', p);
		}
	}

	if (initialize_firecrawl_agent()) {
		for (const p of get_firecrawl_agent_providers()) {
			available_providers.processing.add(p);
			register_provider('processing', p);
		}
	}

	if (initialize_context_dev()) {
		for (const p of get_context_dev_providers()) {
			available_providers.processing.add(p);
			register_provider('processing', p);
		}
	}

	// Log available providers
	console.error('Registered providers (API key present):');
	if (available_providers.search.size > 0) {
		console.error(
			`- Search: ${Array.from(available_providers.search).join(', ')}`,
		);
	} else {
		console.error('- Search: None available (missing API keys)');
	}

	if (available_providers.ai_response.size > 0) {
		console.error(
			`- AI Response: ${Array.from(available_providers.ai_response).join(', ')}`,
		);
	} else {
		console.error('- AI Response: None available (missing API keys)');
	}

	if (available_providers.processing.size > 0) {
		console.error(
			`- Processing: ${Array.from(available_providers.processing).join(', ')}`,
		);
	} else {
		console.error('- Processing: None available (missing API keys)');
	}
};

export const register_tools = (server: McpServer<GenericSchema>) => {
	register_result_read(server);
	register_web_search(server);
	register_github_search(server);
	register_ai_search(server);
	register_web_extract(server);
	register_brave_llm_context(server);
	register_brave_media_search(server);
	register_brave_news_search(server);
	register_firecrawl_agent(server);
	register_context_dev_tools(server);
};
