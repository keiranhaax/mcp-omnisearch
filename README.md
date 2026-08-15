# mcp-omnisearch

[![built with vite+](https://img.shields.io/badge/built%20with-Vite+-646CFF?logo=vite&logoColor=white)](https://viteplus.dev)
[![tested with vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

> [!IMPORTANT]
> This repository is a customized fork of
> [spences10/mcp-omnisearch](https://github.com/spences10/mcp-omnisearch).
> It preserves the original project's unified search foundation while
> maintaining a different provider catalog, expanded tool surface,
> hardened remote transport, and production-oriented result handling.
> Kagi and You.com integrations are not included in this fork.

A Model Context Protocol (MCP) server that gives agents one interface for
web search, cited research, GitHub discovery, content extraction, news
and media search, web automation, and business intelligence.

The current fork integrates Tavily, Brave, Exa, GitHub, Linkup,
Firecrawl, and Context.dev through four consolidated tools and ten
focused tools. Tools and providers are registered only when their
required API keys are available.

## What this fork adds

- **Expanded MCP surface:** 14 tools covering search, research,
  extraction, news, media, autonomous web tasks, brand intelligence,
  style guides, business classification, and transaction
  identification.
- **Modern and legacy MCP compatibility:** MCP `2026-07-28` plus
  stateless legacy `2025-11-25` support over `/mcp`.
- **Hardened HTTP transport:** a narrow guard in front of a pinned
  project-local `mcp-proxy`, with Host and Origin allowlists, strict
  routes, a 4 MiB body limit, request deadlines, and protocol-header
  enforcement.
- **Private large-result pagination:** oversized responses are stored
  with opaque IDs in a private, bounded, expiring result store and read
  through `result_read`.
- **Runtime provider health:** MCP resources report configured providers,
  recent successes, and degraded states without exposing credentials.
- **Defensive provider handling:** runtime response validation, typed and
  redacted errors, bounded retries, and current provider-contract
  compatibility.
- **Safer extraction:** public HTTP(S) URL validation blocks credentials,
  loopback, private networks, link-local addresses, and common metadata
  endpoints.
- **Production-oriented runtime:** explicit environment allowlisting,
  path-independent startup, pinned package tooling, and documented
  staging and rollback procedures.

## Providers

| Capability | Providers |
| --- | --- |
| Web search | Tavily, Brave, Exa |
| AI answers and research | Exa Answer, Exa Deep Research, Brave Answers, Tavily Research, Linkup |
| GitHub discovery | GitHub |
| Extraction and processing | Tavily Extract, Exa Contents/Similar, Firecrawl |
| News, media, and RAG context | Brave News, Brave Media, Brave LLM Context |
| Autonomous web tasks | Firecrawl Agent |
| Web and business intelligence | Context.dev |

Provider availability depends on configuration and provider-side
entitlements. Missing keys disable only the affected capabilities.

## MCP tools

### Consolidated tools

- `web_search`: search with Tavily, Brave, or Exa. Supports provider-aware
  domain filters, Brave operators, and advanced Exa retrieval options.
- `ai_search`: cited answers and research through Exa, Brave Answers,
  Tavily Research, or Linkup.
- `github_search`: search public GitHub code, repositories, and users with
  standard GitHub qualifiers.
- `web_extract`: use Tavily extraction, Exa contents/similar pages, or
  Firecrawl scrape, summarize, crawl, map, extract, actions, and search.

### Focused tools

- `brave_llm_context`: retrieve LLM-ready Brave grounding chunks.
- `brave_news_search`: search recent news with freshness, locale,
  SafeSearch, pagination, and extra snippets.
- `brave_media_search`: search Brave images or videos.
- `firecrawl_agent`: run credit-sensitive multi-step Firecrawl web tasks.
- `context_web_extract`: scrape markdown/HTML/images/screenshots, crawl,
  map sites, or search the web with Context.dev.
- `context_brand_intel`: retrieve company and brand identity data.
- `context_styleguide`: extract style-guide signals and fonts.
- `context_classify`: classify companies using NAICS, SIC, or EIC.
- `context_transaction_identify`: resolve transaction descriptors to
  brands or companies.
- `result_read`: paginate oversized results using opaque result IDs.

The exact tool list is dynamic. A tool is omitted from MCP discovery when
its required provider key is unavailable.

## Search operators and provider options

Brave accepts operators directly in the query string:

- `site:example.com`, `-site:example.com`
- `filetype:pdf` or `ext:pdf`
- `intitle:term`, `inurl:term`, `inbody:term`, `inpage:term`
- `lang:en`, `loc:us`
- `before:2024`, `after:2024-01-01`
- `"exact phrase"`, `+required`, `-excluded`

GitHub search supports qualifiers such as `filename:`, `path:`, `repo:`,
`user:`, `language:`, and `in:file`.

Tavily and Exa expose provider-aware domain and retrieval options through
their tool schemas. Inspect MCP discovery for the current schema instead
of assuming every provider accepts the same fields.

## Configuration

### Local stdio client

Build the project, then configure any stdio-capable MCP client:

```json
{
  "mcpServers": {
    "mcp-omnisearch": {
      "command": "node",
      "args": ["/path/to/mcp-omnisearch/dist/index.js"],
      "env": {
        "TAVILY_API_KEY": "your-tavily-key",
        "BRAVE_API_KEY": "your-brave-key",
        "BRAVE_ANSWERS_API_KEY": "your-optional-brave-answers-key",
        "GITHUB_API_KEY": "your-github-key",
        "EXA_API_KEY": "your-exa-key",
        "LINKUP_API_KEY": "your-linkup-key",
        "FIRECRAWL_API_KEY": "your-firecrawl-key",
        "CONTEXT_DEV_API_KEY": "your-context-dev-key"
      }
    }
  }
}
```

Only add keys for providers you intend to use. Keep credentials out of
source control.

### Environment variables

| Variable | Capability |
| --- | --- |
| `TAVILY_API_KEY` | Tavily search, extraction, and research |
| `BRAVE_API_KEY` | Brave web, news, media, LLM context, and Answers fallback |
| `BRAVE_ANSWERS_API_KEY` | Optional separate Brave Answers credential |
| `GITHUB_API_KEY` | GitHub code, repository, and user search |
| `EXA_API_KEY` | Exa search, answers, deep research, contents, and similar pages |
| `LINKUP_API_KEY` | Linkup sourced answers |
| `FIRECRAWL_API_KEY` | Firecrawl processing, search, and agent tools |
| `FIRECRAWL_BASE_URL` | Optional self-hosted Firecrawl base URL |
| `FIRECRAWL_AGENT_URL` | Optional Firecrawl Agent endpoint override |
| `CONTEXT_DEV_API_KEY` | Context.dev web and business-intelligence tools |
| `OMNISEARCH_RESULT_DIR` | Private result-store directory |
| `OMNISEARCH_RESULT_TTL_MS` | Result retention, default 24 hours and maximum 7 days |
| `OMNISEARCH_RESULT_MAX_BYTES` | Per-result limit, default 25 MiB |
| `OMNISEARCH_RESULT_STORE_MAX_BYTES` | Total quota, default 256 MiB with oldest-first eviction |

The result directory is created with mode `0700`; stored results use mode
`0600`. `result_read` returns at most 500 lines per request.

### GitHub token

For public GitHub search, use a token limited to public repository access.
Do not grant private-repository scopes unless that access is deliberately
required by your deployment.

### Self-hosted Firecrawl

Set `FIRECRAWL_BASE_URL` to a Firecrawl instance exposing the expected v2
endpoints. A `FIRECRAWL_API_KEY` is still required. Use
`FIRECRAWL_AGENT_URL` only when the Agent endpoint differs from the base
URL.

## Transport and deployment

### Stdio

The core server runs over stdio:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build
node dist/index.js
```

### Hardened MCP HTTP deployment

This fork includes a production deployment path:

```text
client -> HTTP guard -> mcp-proxy@6.7.3 -> stdio server
```

It supports modern MCP `2026-07-28` and stateless legacy MCP
`2025-11-25` on `POST /mcp`. `GET /ping` is the only health route. The
legacy `/sse` route is intentionally retired.

Authentication remains in `mcp-proxy`; the guard enforces network and
protocol boundaries without inspecting the API key. See:

- [Production deployment](docs/deployment.md)
- [MCP 2026-07-28 architecture decision](docs/architecture-decision-mcp-2026-07-28.md)
- [Provider synchronization matrix](docs/provider-synchronization.md)

The checked-in production runbook documents this fork's deployed topology.
Adapt hosts, ports, process management, and credentials for your own
environment.

### Docker and OpenAPI

The Docker image uses MCPO to expose the stdio server as HTTP/OpenAPI for
clients such as OpenWebUI:

```bash
git clone https://github.com/keiranhaax/mcp-omnisearch.git
cd mcp-omnisearch
cp .env.example .env 2>/dev/null || touch .env
# Add only the provider keys you need to .env
docker compose up -d --build
```

The default container port is `8000`, and the generated MCPO route is
`/omnisearch`. This Docker/MCPO path is separate from the hardened native
`/mcp` deployment described above.

## Examples

### Brave operator search

```json
{
  "query": "filetype:pdf site:microsoft.com +typescript -javascript",
  "provider": "brave",
  "limit": 10
}
```

### Exa deep research

```json
{
  "query": "Compare current MCP transport security guidance",
  "provider": "exa_deep_research",
  "exa_deep_search_type": "deep-reasoning"
}
```

### Firecrawl search

```json
{
  "provider": "firecrawl",
  "mode": "search",
  "query": "Model Context Protocol security",
  "firecrawl_search_options": {
    "sources": ["web", "news"],
    "limit": 10
  }
}
```

### Read an oversized result

```json
{
  "result_id": "opaque-id-returned-by-another-tool",
  "offset": 1,
  "limit": 200
}
```

## Development

Requires Node.js 22 or newer and the repository-pinned pnpm release.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm test
corepack pnpm run build
```

Use an isolated branch or worktree for non-trivial changes. Do not use a
live deployment checkout as a scratch workspace.

## Fork scope and upstream relationship

This is a maintained customization, not a drop-in mirror of upstream.
Notable differences include:

- Kagi and You.com integrations are removed.
- Brave, Firecrawl, Exa, and Context.dev capabilities are expanded.
- Result delivery uses private authenticated pagination rather than
  exposing local filesystem paths to remote clients.
- The fork retains its own provider dispatch, runtime-health model,
  validation, and deployment architecture.
- Upstream changes are reviewed and selectively ported instead of merged
  blindly when they conflict with the fork's contracts or production
  safeguards.

The original project and authorship remain credited to
[Scott Spence's mcp-omnisearch](https://github.com/spences10/mcp-omnisearch).
See the repository's fork relationship and Git history for provenance.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Keep changes focused, preserve public MCP contracts unless a breaking
change is intentional, and include verification for provider, schema,
transport, or deployment changes.

## License

MIT License. See [LICENSE](LICENSE).

## Acknowledgments

This customized fork builds on the original
[mcp-omnisearch](https://github.com/spences10/mcp-omnisearch) and the
services provided by:

- [Model Context Protocol](https://github.com/modelcontextprotocol)
- [Tavily](https://tavily.com)
- [Brave Search](https://search.brave.com)
- [Exa](https://exa.ai)
- [GitHub](https://github.com)
- [Linkup](https://linkup.so)
- [Firecrawl](https://firecrawl.dev)
- [Context.dev](https://context.dev)
