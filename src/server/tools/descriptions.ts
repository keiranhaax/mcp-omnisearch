export const tool_descriptions = {
	web_search:
		'Search: find web pages, articles, or data. Use Brave for operators, Exa for semantic or deep search, Tavily for factual results, and You for LLM-ready snippets.',
	github_search:
		'Search GitHub: find code, repositories, or users. Supports filename:, path:, repo:, user:, language:, and in:file syntax.',
	ai_search:
		'Answer/Research: get synthesized answers with citations. Use Exa for fast or deep research, Brave Answers as fallback, and Tavily/You only when needed.',
	web_extract:
		'Extract/Process: read or process known URLs. Firecrawl handles scrape/summarize/crawl/map/extract/actions/search; Exa handles contents/similar; Tavily extracts.',
	brave_llm_context:
		'Research Context/RAG: retrieve LLM-ready grounding chunks from Brave. Use for dense context, not ordinary link search.',
	brave_news_search:
		'News Search: find recent news articles with freshness, pagination, country/language, SafeSearch, and snippets.',
	brave_media_search:
		'Media Search: find Brave image or video results with SafeSearch and country/language filters. Use only when visual media results are needed.',
	firecrawl_agent:
		'Autonomous Web Agent: Firecrawl agent for multi-step web data tasks. Credit-sensitive; use only when search/extract is not enough.',
	context_web_extract:
		'Context.dev Web: scrape markdown/HTML/images/screenshots, crawl pages, get sitemaps, or web-search with optional markdown scraping.',
	context_brand_intel:
		'Context.dev Brand: retrieve brand/company intelligence such as logos, colors, socials, descriptions, industries, and domain/company/ticker matches.',
	context_styleguide:
		'Context.dev Design: extract styleguide signals and optional fonts for a domain or direct URL.',
	context_classify:
		'Context.dev Business: classify companies by NAICS, SIC, or EIC using domain or company name.',
	context_transaction_identify:
		'Context.dev Transactions: identify messy bank/card transaction descriptors as real brands or companies.',
} as const;

export type OmnisearchToolName = keyof typeof tool_descriptions;
