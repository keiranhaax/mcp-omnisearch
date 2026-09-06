# Audit remediation: native MCP reliability

This record covers the follow-up to `7e3122c` in the existing
`fix/reliability-audit-20260905` worktree. It describes candidate
source behavior, not a production deployment. The unrelated
documentation cleanup and untracked handoff in that worktree are
preserved separately.

## Transport and protocol

The existing Node guard -> pinned mcp-proxy -> stdio server topology
is retained. Package versions are unchanged; reproducible pnpm patches
include source and published runtime bundles where applicable.

- Proxy stdout decoding uses `StringDecoder` and a 10 MiB per-line
  byte limit. Incomplete UTF-8 sequences survive pipe chunk
  boundaries.
- Unexpected upstream closure or fatal framing failure exits the proxy
  nonzero so existing supervision can restart the entire chain.
  Intentional shutdown remains distinct.
- `GET /ready` performs a bounded 1-second MCP ping against the stdio
  child and returns only `ready`/`unavailable` with HTTP 200/503. The
  guard forwards it. `/ping` remains a liveness endpoint.
- Unknown tools/resources return JSON-RPC invalid-params errors.
  Explicit MCP error codes survive serialization; unexpected
  exceptions are sanitized. Validation diagnostics omit submitted
  values, cap issue/path counts, and show only schema-owned
  fields/constraints.
- Modern subscription acquisition requires a validated SSE listen
  response and the resource-subscription capability. HTTP-200 RPC
  errors cannot acquire upstream leases. Disconnect during acquisition
  releases a late lease.
- Modern HTTP disconnect cancels work. Legacy disconnect does not
  imply cancellation; explicit cancellation is still required. Backend
  stdio admission remains held until the handler settles, not until
  the downstream HTTP connection closes.
- Stdio framing, backend work and output queues are bounded.
  Cancellation and protocol control messages remain serviceable while
  work is full. Repeated initialization does not multiply transport
  listeners.

## Guard admission and HTTP headers

Authentication, Host/Origin checks, body limits and the no-CORS policy
remain enforced. Four independent request-window counters cover
rejected traffic, normal authenticated work, cancellation, and health
probes. Rejected requests no longer exhaust the authenticated work
quota.

Existing `GUARD_RATE_LIMIT_REQUESTS` and `GUARD_RATE_LIMIT_WINDOW_MS`
continue to bound work and rejected traffic independently. Health and
control rates are each the smaller of 120 and the configured request
limit. Health has four concurrent slots. When work admission is full,
four reserved intake slots allow authenticated cancellation; these
accept at most 8 KiB and have at most a 1-second body deadline. Other
requests using that reserve are rejected. Raw connection limits remain
global.

Guard-generated 401 responses include
`WWW-Authenticate: ApiKey realm="omnisearch"`. Forwarded
`Access-Control-*` headers are stripped. The existing Caddy
authentication translation is not modified.

## Resource controls and metrics

The native launcher passes through these optional, validated settings:

- `OMNISEARCH_MAX_INFLIGHT`: default 16, maximum 256 backend
  operations.
- `OMNISEARCH_STDIO_MAX_FRAME_BYTES`: default 4 MiB, maximum 16 MiB.
- `OMNISEARCH_STDIO_MAX_OUTPUT_BYTES`: default 1 MiB, maximum 16 MiB,
  including queued and stream-buffered output.

HTTP provider work is limited to four active requests and 32 queued
requests per provider family. Queue cancellation removes the waiter;
overflow fails without an automatic retry. Firecrawl, Brave, Tavily
and Exa adapters share their respective family limits. One MCP call
has a 25 MiB aggregate HTTP response budget across nested
adapters/retries. GitHub retains its separate Octokit request path and
overall deadline; its execution is bounded by backend admission, not
the HTTP helper's family semaphore.

The existing authenticated `omnisearch://providers/status` resource
adds `resource_usage`: active/queued requests,
completed/failed/rejected counters, and cumulative admitted HTTP
duration per family. These are process-local request counters, not
billing, entitlement, or percentile latency claims. No queries, URLs,
bodies or credentials are collected.

## Provider and timeout contracts

- Ordinary retrying adapters share their configured timeout across
  attempts and backoff. `RetryOptions.timeout_ms` is optional for
  other internal callers. Firecrawl polling has separate GET attempt
  timeouts and overall operation cancellation.
- Long Retry-After waits are chunked safely rather than overflowing
  into immediate timers. Unrepresentable GitHub retry delays fail
  closed.
- Tavily research keeps the default creation-and-wait behavior. When
  its own wait expires after acceptance, it returns a resumable
  request ID. `ai_search` with `provider="tavily_research"`,
  `action="status"`, and `request_id` performs one status GET without
  creating a new paid job. Omit `query` for status. Other research
  calls still require `query`. Caller cancellation still cancels local
  work and can suppress delivery; this change does not claim that
  local cancellation cancels remote jobs.
- Exa contents preserves per-ID statuses and reports all-failed
  requests as errors rather than successful empty extraction. No
  fabricated replacement content is returned.
- Brave local generic/POI/map grounding is retained. Brave Answers,
  News/Media and Exa deep responses are validated at runtime.
- Firecrawl answer/highlights may be null. Usable other content is
  kept; explicit no-match results retain their original document
  metadata.
- Single-target map/crawl/extract/actions/similar modes reject
  multi-URL requests before dispatch instead of silently using only
  the first URL.
- Result counts/pagination use bounded integers. You.com applies the
  requested limit to the combined web/news results.

## Large-result storage

Opaque result IDs, UTF-8 line/byte pagination, TTL, and physical disk
quotas remain. Readers support existing `.txt` results and a
compressed fallback for canonical logical content that exceeds the
physical quota. The compressed representation is internal:
`result_read` returns the original text and canonical JSON, not a new
consumer encoding.

Sparse line checkpoints every 64 KiB avoid rescanning entire results
on each page. The cache holds at most 16 indexes and one decoded
result of at most 100 MiB. Decompression validates the format and
logical length; corrupt or oversized files are rejected. Optional
readable copies are skipped when the canonical JSON itself requires
compression. Every original JSON field remains reconstructible.

Compression is not a quota exemption: physical per-result and
total-store limits still apply, alongside a hard decoded logical
limit. Large incompressible outputs can still fail explicitly.
Rollback to an older reader cannot read new compressed results; retain
the updated reader until those results expire or accept that temporary
compatibility limit.

## Deliberate limits

- No Docker, paid provider calls, service restart, or production build
  is part of this change. A merge into the live checkout's `main` is
  not a deployment of its generated artifacts or dependencies.
- A blanket package-version upgrade is deferred. Targeted backports
  address demonstrated defects while retaining tested compatibility.
- Full async filesystem conversion, streaming result normalization,
  event-loop/heap profiling, percentile metrics and automatic
  concurrency tuning are deferred. Initial serialization, indexing,
  compression and decompression still use bounded synchronous work;
  latency at realistic load remains to be measured.
- No automatic cross-provider fallback or result cache is introduced:
  these change spend, privacy or freshness semantics and need separate
  product decisions.
- Direct stdio is not newly advertised as a native modern-protocol
  implementation. Modern `/mcp` compatibility remains supplied by the
  proxy.

## Verification

The intended snapshot was copied from Git plus only the implementation
paths into a temporary verification directory, not another Git
worktree. No credentials, generated output, or unrelated uncommitted
documentation were copied. On Node.js 22.23.2, a new empty private
store and `--package-import-method=copy` proved patch reproducibility:

- `corepack pnpm install --frozen-lockfile --store-dir <private-store> --package-import-method=copy`:
  passed.
- `./node_modules/.bin/vp check`: formatting, lint and types passed.
- `./node_modules/.bin/vitest run`: 672 tests passed across 61 files.
- `./node_modules/.bin/vp pack`: passed.
- `node scripts/smoke-mcp.mjs`: 12 isolated offline groups passed,
  including readiness and bounded validation/protocol errors.
- `shellcheck start-server.sh`: passed.

Plain source/doc diffs pass `git diff --check`. Generated pnpm patch
context lines contain required leading spaces before tabs and blank
context lines, which Git's outer diff flags as whitespace.
Patch-source additions were checked separately for trailing
whitespace, and the patches were validated by fresh frozen
installation. No patch context was stripped or altered to silence that
diagnostic.

Independent review found two integration issues that were fixed and
regression-tested: aborted-but-unsettled fetches retain provider
permits, and outer deadline failures retain safe timeout reporting and
provider health classification. Production PIDs, generated build
hashes, and pre-existing documentation hashes were compared
throughout. Main merge status is recorded by Git, not inferred from
successful tests.
