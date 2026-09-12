# Structured outputs and bounded search/read

This is an additive source implementation, not a deployment record.
Client-side discovery and programmatic composition remain client
concerns; no server-side tool-search layer, code executor, SDK
package, capability filter, or replacement of the existing tools is
introduced.

## Structured output compatibility

`web_search`, `web_extract`, and `search_and_read` declare an
object-root MCP `outputSchema` and return `structuredContent`:

- Success: `{ "ok": true, "data": ... }`.
- Handler failure:
  `{ "ok": false, "error": { "kind": ..., "retryable": ... } }`,
  alongside `isError: true`. Bounded provider/status identifiers can
  be included. Existing redacted text remains the human-readable
  message.

The web tools keep their original JSON text shapes: arrays, processing
objects, and retained/compact/full results. The `data` field matches
the parsed text on success. Legacy input schemas and provider defaults
are unchanged. Code should inspect `isError` before assuming
structured output: input-schema rejection and protocol/transport
errors occur before these handlers and retain the installed MCP
library's existing error contract. Other tools, including
`result_read`, are unchanged.

The shared output schema describes normalized search, processing,
stored handle, and presentation fields. Provider metadata is
extensible. The root schema requires `ok`; the render helpers enforce
exactly one of `data` and `error`. Consumers must not treat the schema
as a dependent-field validator for arbitrary external values.

### Output budgets

Budgets include both JSON text and structured content, measured as
UTF-8 bytes of the serialized MCP tool result. They exclude JSON-RPC
framing. They are not token estimates. Mirroring text into structured
output costs bytes and may cause earlier retention or fewer inline
passages.

- Web-tool legacy mode: the existing 80000-byte envelope ceiling now
  includes structured content. The existing retained-handle contract
  is used when the combined response exceeds the ceiling.
- Explicit compact/full modes: the existing 2048–80000 byte limits and
  defaults remain. Full canonical evidence is stored before selection.
  When no useful selected envelope fits, compact may return a retained
  handle. A provenance envelope that cannot fit fails explicitly.
- `search_and_read`: 12000-byte default; 2048–80000 accepted. Returns
  full canonical results when they fit, source-linked selected
  passages when feasible, otherwise a retained handle. No evidence is
  silently discarded to meet the presentation limit.

Storage failure returns a bounded `storage_failure` without a false
handle. Existing private-directory permissions, opaque IDs, expiry,
eviction and quotas remain. Shared credentials/results do not
establish tenant isolation. `result_read` recovers what the gateway
received, not provider-omitted page content.

Legacy retention failures preserve their prior redacted text while
reporting `storage_failure` with `retryable: false`. Local quota and
filesystem failures do not mark the upstream provider unhealthy.

## `search_and_read` experiment

Required: `query`, `search_provider`, `extract_provider`.

- Search: configured Tavily, Brave, Exa, or You.com adapters.
- Read: configured Tavily extract, Exa contents, or Firecrawl scrape.
- `search_limit`: 1–20, default 5. Must be at least `max_sources`.
- `max_sources`: 1–5, default 3.
- `max_requests`: 2–20, default 8. Counts attempted provider HTTP
  requests, including adapter retries. It is not a monetary or credit
  budget.
- `timeout_ms`: 100–60000, default 30000. Whole workflow network
  deadline; normal bounded serialization and retention happen
  afterward.
- `output_budget_bytes`: described above.

```json
{
	"query": "database connection pooling documentation",
	"search_provider": "brave",
	"extract_provider": "tavily",
	"search_limit": 5,
	"max_sources": 3,
	"max_requests": 8,
	"timeout_ms": 30000,
	"output_budget_bytes": 12000
}
```

The tool preserves provider ordering and deduplicates identical URL
strings. It does not normalize query parameters, fragments, redirects,
or canonical URLs. The first unique hits count toward the source cap,
including unsafe or failed hits. It does not replace those hits with
an additional search. Each selected source is read sequentially to
make request accounting, per-source errors, and cancellation
predictable. This is not batch-optimized.

Only basic extraction is used. No synthesized answer, advanced
extraction, crawl, map, actions, paid research job, provider fallback,
or local fetch is introduced. Existing search-adapter defaults and
provider query limits still apply, including Brave's narrower query
limit.

Actual HTTP attempts consume a shared request-scoped budget
immediately before dispatch. Nested adapter retries share that budget
and the existing aggregate response-byte budget. API redirects are
rejected in this workflow to avoid uncounted redirect hops; ordinary
tools retain their redirect behavior. Provider-internal page fetches
and billing are outside this count. Caller cancellation and workflow
deadlines propagate through existing HTTP, retry and concurrency
helpers. Once exhausted/aborted, further sources are marked skipped
instead of starting new requests.

### Evidence and partial results

`presentation` is `complete`, `selected`, or `retained`, independently
of whether all selected sources succeeded. Each selected source is
`ok`, `error`, or `skipped`, with a stable source ID and provider
identity. Per-source errors use safe classifications, including
`request_budget`. Unsafe input URLs are not fetched and their
URL/title/snippet are omitted from that source's public record rather
than reflecting credential-bearing or internal targets.

Successful canonical entries include text, the normalized extraction,
and safe reported request metadata. Provider-reported partial evidence
is retained while that source is marked incomplete. Unknown usage is
not estimated. A failure to search returns a tool error. Read failures
return available evidence plus per-source errors, even if every read
fails.

`metadata.complete` means all selected sources returned nonempty
content without a provider-reported failure. It does not certify full
original page coverage or that every search hit was read.
`considered_hits`, `duplicates_removed`, and `sources_omitted`
distinguish the bounded selection. A selected/retained presentation
keeps a small metadata subset inline; `result_read` recovers the
complete canonical record.

Selected passage offsets are UTF-16 code units into the retained
source's `content`, not original HTML. Passage selection is
deterministic lexical selection using the query, not a relevance
guarantee. Full citation-bearing text remains recoverable through the
retained handle.

## Offline comparison and scope

The repeatable fixture in `src/server/tools/search_and_read.test.ts`
compares identical two-source evidence through:

- Bundled sequential workflow: one MCP call, three provider HTTP
  calls.
- Separate per-source primitives: three MCP calls, three provider HTTP
  calls.
- Search plus batch extraction: two MCP calls, two provider HTTP
  calls.

The fixture checks identical extracted text and prints actual
serialized payload sizes. The bundle's provenance can make its output
larger; adding structured content also increases wire size. Do not
infer lower provider cost or context use from fewer MCP calls. Client
code-mode composition can already suppress intermediate outputs
without a server bundle.

Offline tests cover deterministic behavior, dispatch, deadlines,
cancellation, request accounting, retention, schema discovery and
compatibility. They do not measure agent tool-selection accuracy, live
provider latency, billing, or real-world relevance. Those remain
separately authorized evaluation work.

## Development checks

Use the existing pinned dependencies and an isolated result directory:

```bash
./node_modules/.bin/vitest run src/server/tools/search_and_read.test.ts src/server/tools/structured_output.test.ts src/common/request_budget.test.ts
./node_modules/.bin/vp check
./node_modules/.bin/vitest run
./node_modules/.bin/vp pack
node scripts/smoke-mcp.mjs
node scripts/smoke-search-workflow.mjs
node src/server/fixtures/evolution-discovery/capture.mjs --workflow
node src/server/fixtures/evolution-p1b/smoke.mjs
git diff --check
```

The workflow smoke probe starts the built stdio server with synthetic
credentials and a strict fixture-only fetch implementation. It
exercises successful structured output, budgeted workflow evidence and
lossless pagination. Direct stdio negotiates the installed library's
`2025-06-18` protocol; the separate guard/proxy smoke verifies modern
`2026-07-28` and legacy `2025-11-25` HTTP support. These are different
transport layers.

Historical P0 schema/response fixtures remain unchanged. Compatibility
tests remove only reviewed output-schema/structured-content additions
and the new workflow before comparing against those fixtures. No
production artifact, service, credential, existing unfinished
worktree, or remote ref is modified.

## Verified source checkpoint

Prepared on branch `feature/structured-search-workflow-20260912`,
based on `c4c8e4f`, in an isolated worktree. The existing pinned
dependencies were installed with a private pnpm store and copy
imports, without changing manifests, lockfiles, or dependency patches.

- Unchanged-source baseline: 1779 tests passed across 74 files.
- Final implementation: 1857 tests passed across 77 files, no skipped
  or failed tests; 78 additional cases compared with the baseline.
- Vite+ format/lint/types and build passed.
- Guard/proxy smoke passed 14 checks, including both HTTP protocol
  eras, structured errors before networking, and transport
  protections.
- Built workflow smoke passed with exact evidence recovery across four
  result pages. Four discovery profiles passed without fixture
  refresh.
- The existing P1B success probe also passed with an explicit
  4096-byte compact-selection budget and 2048-byte full-result budget.
- Independent review identified a legacy retention classification gap.
  Eight quota/filesystem regressions reproduced it before the fix;
  default and explicit legacy modes now retain safe text, classify
  storage failure correctly, and leave provider health unchanged.

All provider responses in verification were offline fixtures. Source
changes are uncommitted; no merge, publication, production build,
deployment, or service restart is part of this checkpoint. Live
relevance, latency and provider billing remain unverified.
