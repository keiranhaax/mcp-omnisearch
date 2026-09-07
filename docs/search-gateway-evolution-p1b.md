# Search gateway evolution: P1B compact evidence

Date: 2026-09-07. Base: `a2fbc86cc8cd5a3c58764b5ea8b0f04d513d36de`.
**P1B source implementation and offline validation complete.** Changes
are uncommitted in the existing isolated worktree:
`/home/ubuntu/worktrees/mcp-omnisearch-evolution-p0-20260906`, branch
`feature/search-gateway-evolution-p0-20260906`.

## Authority and boundary

The user approved P1B implementation and offline validation,
explicitly retaining shared trusted-client result access. All clients
sharing this instance/result directory belong to the same privacy
boundary. Opaque IDs and private file permissions are not per-client
ownership checks. No authentication/identity propagation was added.

Approved surfaces: common result/passage helpers, search/extract
tools, Tavily request metadata, tests/discovery fixtures, and
documentation. No dependency installs, lockfile changes, commits,
merges, pushes, paid/live provider calls, production writes, or
service operations.

## Implemented contract

- `web_search` and `web_extract` have additive optional
  `response_mode: legacy | compact | full` and
  `output_budget_bytes: integer 2048..80000`.
- Omitted/legacy mode retains the old JSON shape, offload threshold
  and reader behavior. A budget requires explicit compact/full mode;
  bad modes, types, bounds, and incompatible budget use reject before
  provider dispatch.
- Compact defaults to 12000 bytes, full to 80000. The budget covers
  UTF-8
  `JSON.stringify({content:[{type:'text',text:JSON.stringify( value,null,2)}]})`,
  not just content text and not JSON-RPC framing.
- Small complete normalized responses stay inline in either new mode.
  Full mode otherwise returns a retained handle. Compact mode selects
  source passages and returns the canonical handle. Neither mode asks
  a provider for extra content or bypasses storage quotas.
- Canonical normalization removes only aggregate `content` that
  exactly equals `raw_contents[].content` joined with two newlines.
  Distinct aggregate summaries and metadata remain. It does not
  deep-deduplicate every provider-specific representation.
- Omitted evidence is stored first as one canonical JSON document,
  including below the legacy 80000-byte offload threshold. It has
  `metadata` and `result`; no second readable view is appended. The
  stored metadata says complete locally. Initial handles say retained
  or selected. Storage failure returns a fixed bounded error without
  exposing content or issuing a false handle.
- Existing `result_read`, `.txt`/`.omr`, TTL, oldest-first eviction,
  per-result/aggregate quotas, and private permissions are unchanged.
  Reconstruction follows line and byte continuation exactly.
- Source IDs are JSON Pointers within canonical `result`. Passage
  offsets are UTF-16 code units in normalized source text, not HTML.
  Returned source URLs keep their meaningful query parameters.
  Multi-page aggregate passages are not labelled with the seed URL.
- Passage ranking uses distinct literal Unicode word/emoji tokens,
  deterministic position tie-breaking, bounded hit contexts, merged
  overlap, and source-order output. Blank queries use `leading`;
  unmatched queries use `no_hit`. Found but unselectable matches
  remain labelled `query`, without fabricated passages.
- ATX/Setext headings, top-level backtick/tilde fences, and
  conservative whitespace-delimited URL/bracket-citation tokens are
  atomic. Oversized atoms are omitted rather than cut. Surrogate pairs
  are never split. Nested Markdown fences, full link grammar, and
  grapheme-cluster preservation are not claimed.
- Work uses a 4096-unit query prefix, 32 distinct terms, sampled hits,
  and at most 128 ranges. Compact source-count/allowance reductions
  are bounded geometrically and prefer fewer useful previews to many
  empty identities. It is a lexical heuristic, not semantic retrieval.
- Request-level metadata includes provider/operation, measured adapter
  elapsed milliseconds, local completeness, detected failed-source
  status, and unknown provider-page completeness. Tavily root request
  ID, numeric response time, and numeric credit usage are allowlisted
  and associated through a WeakMap, not repeated on source entries.
  Missing/malformed measurements stay absent/unknown; usage is null
  unless provider-reported. Numeric strings are not coerced. Other
  providers' existing metadata is preserved, not reinterpreted.
- No upstream `include_usage` flag is added. Live usage therefore
  normally remains unknown unless returned by the provider. No money
  estimate is represented as a provider charge.

## Verification and corrections

The unchanged source passed **777 tests in 66 files** before edits.
Changes followed focused failing behavioral regressions before their
implementation. Recorded RED runs cover opt-in full output,
byte-budget retention, compact selection, cross-field validation,
bounded storage errors, metadata exposure, and passage behavior. Some
edge cases passed immediately and are characterization, not
misreported as RED evidence.

Independent review found and the integrated implementation corrected:

1. Many sources under a tight budget could return only empty previews.
   A failing regression now requires useful evidence and honest source
   omission counts.
2. Aggregate content could be misattributed to a seed URL. Regressions
   cover similar/crawl/map/search modes and retain individual URLs.
3. Removing one source at a time serialized every suffix. Geometric
   source-count reduction removes that quadratic loop.
4. Plain windows could cut URLs/citation tokens. Three observed
   failing token-boundary regressions now pass after conservative atom
   merging.

Final runtime gate:

- **908 tests passed in 70 files**, zero failed or pending.
- Format/lint/type checks passed. An initial documentation formatting
  failure was corrected on only the two affected Markdown files.
- Node 22 build passed using the existing installed dependencies.
- **12 offline native HTTP smoke groups passed**, including both proxy
  protocol eras, auth/Host/Origin checks, routes, discovery,
  pagination and pre-network validation.
- **Four built-stdio discovery profiles passed**: 14 all-provider
  tools, 1 no-provider tool, 13 without GitHub, and 4 Tavily-only
  tools. Direct stdio still negotiates `2025-06-18`; HTTP protocols
  are separate.
- Built positive-path smoke ran compact and full through the actual
  `dist/index.js`, mocked only upstream fetch, blocked socket
  networking, and reconstructed exact canonical content through
  `result_read`. Compact returned **1879 bytes**, full handle **775
  bytes**, both under 2048; both reconstructed in **2 reads**. Two
  synthetic provider calls, zero real provider calls; invalid controls
  made no extra request.
- ShellCheck and `git diff --check` passed.
- All **18 historical fixture/snapshot files** remained byte-identical
  to HEAD. Discovery accepts only the two new optional properties on
  the two public tools after the existing P1A delta. P0/P1A fixtures
  were not refreshed.

Real public dispatch reconstruction covers all four search providers
and Tavily/Firecrawl/Exa extraction with synthetic HTTP responses, not
mocked adapters. Storage tests cover private permissions, expiry,
aggregate eviction, separate directories, failure, exact byte
boundaries, Unicode/escaping, large source identities, and
below-threshold retention. Existing tests retain the explicitly
shared-instance privacy contract.

### Measured synthetic fixtures

Values are serialized initial MCP tool-result bytes, not token
estimates:

- Long report: **29087 legacy → 1714 compact**, 2 canonical reads.
- CJK: **25646 → 2028**, 2 reads.
- Fenced code: **16896 → 1748**, 1 read.
- No-hit leading fallback: **22832 → 1859**, 1 read.

All four expected evidence anchors were retained and canonical content
matched exactly. Measured local dispatch timings are recorded in the
[JSON evidence](search-gateway-evolution-p1b.json); cold-start effects
and synthetic networking make them unsuitable as provider-latency or
speedup claims. No live relevance, extraction quality, billing, or
percentage improvement is claimed.

## Reproduction

Used installed tools directly to avoid pnpm automatic dependency
repair. The package remains pinned to pnpm 11.9.0; no install was
needed. The existing worktree preparation/private store was reused.
Node was `v22.23.2`, Linux ARM64 on the verified host `vnic-keiran`.

```bash
RUN=/tmp/omnisearch-evolution-p1b-HF26M2ho

env -i PATH="$PATH" HOME="$RUN/home" CI=true \
  ./node_modules/.bin/vitest run --reporter=json \
  --outputFile="$RUN/final-tests.json"
env -i PATH="$PATH" HOME="$RUN/home" CI=true \
  ./node_modules/.bin/vp check
env -i PATH="$PATH" HOME="$RUN/home" CI=true \
  ./node_modules/.bin/vp pack
env -i PATH="$PATH" HOME="$RUN/home" CI=true \
  node scripts/smoke-mcp.mjs
env -i PATH="$PATH" HOME="$RUN/home" CI=true \
  node src/server/fixtures/evolution-discovery/capture.mjs --p1b
env -i PATH="$PATH" HOME="$RUN/home" CI=true \
  node src/server/fixtures/evolution-p1b/smoke.mjs
shellcheck start-server.sh
git diff --check
```

Logs and RED/GREEN reports are in the run directory. It is a temporary
validation artifact, not a backup. Durable measurements and reference
hashes are in the adjacent JSON report. Tests/smokes use temporary
result directories and synthetic credentials. Built smokes tear down
children and their temporary homes. Public unauthenticated Tavily
documentation GETs confirmed metadata fields; hashes/provenance are
recorded in [feature provenance](feature-provenance.md).

## Production, limitations, and next gates

The development HEAD remains P1A `a2fbc86`. Production checkout
remains `047a7e1e3fce8451753e0e8bcffef6dcd13b4554`, with the
preexisting untracked `.hermes/` and `package-lock.json`. Neither was
changed. No production build/restart, merge, push, or commit was
performed. Production process IDs/result metadata were not
independently snapshotted in P1B; no claim of a complete live-state
audit is made.

P1B is source/offline-complete, not a deployment or full release gate.
Live Tavily controls/usage, provider latency/charges, public-page
staging, P2 lifecycle/sanitization, Defuddle/fetch safety, routing,
and branding remain outside this slice. Per-client ownership remains
deliberately absent under the approved privacy boundary. Future
deployment, live provider tests and spend limits, commits, and later
phases need their own explicit approval.

There is no live rollout to undo. The uncommitted scoped diff can be
reviewed and separately committed when requested; do not reset the
live checkout or delete result state as a rollback for isolated
development.
