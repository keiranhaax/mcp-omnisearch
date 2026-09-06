# Search gateway evolution: P1A Tavily controls

Date: 2026-09-06. Base: `69e388a5f9a249a9ad48a8efff78059bb9dc3689`
(P0). **P1A local implementation and offline validation complete.**
This is not completion of all P1, a live-provider readiness claim, or
production deployment.

Approved scope: Tavily search depth/topic/recency, extraction
chunk/format wiring, provider-aware validation, tests/discovery/docs,
and a local commit after verification. Existing isolated worktree:
`/home/ubuntu/worktrees/mcp-omnisearch-evolution-p0-20260906`, branch
`feature/search-gateway-evolution-p0-20260906`. No branch rename or
additional worktree was needed. Git records the resulting commit; this
document records the exact validated source delta from P0.

## Implemented behavior

- `web_search`, provider `tavily`: optional `search_depth` (`basic`,
  `advanced`, `fast`, `ultra-fast`), `topic` (`general`, `news`,
  `finance`), and `time_range` (`day`, `week`, `month`, `year`).
  Default request values remain basic/general; no new time-range field
  is sent unless supplied.
- `web_extract`, provider `tavily`: optional `chunks_per_source`
  integer 1-5 and `format` Markdown/text. Existing query and depth
  support is reused. Query is required for chunks, but not format.
  Unspecified format stays omitted in the request, preserving the P0
  behavior and provider default.
- Wrong-provider use of the new options is rejected before dispatch,
  including explicitly supplied default values. Invalid enums,
  nulls/types, fractional/out-of-range chunks, and chunks without a
  non-empty query are rejected. Errors expose fixed safe guidance,
  never rejected query/URL values or upstream bodies.
- The gateway conservatively rejects `time_range` combined with
  recognized `before:`/`after:` operators. A mapped country operator
  with a non-general topic is rejected because the official API
  documents country boosting only for general searches. These checks
  do not silently discard constraints or reinterpret quoted text.
- Runtime validation remains in both provider adapters and public MCP
  paths. The Valibot search control definition is shared by the tool
  schema and adapter, not a second validation framework.
- Legacy response shapes, request defaults, result retention,
  pagination, explicit provider selection, HTTP retry deadlines,
  source syntax handling, and unrelated providers are unchanged.

Provider-side chunks are not local compact output: a result handle can
recover the full response received by this gateway, not portions of a
page omitted by Tavily. No automatic follow-up extraction is performed
to manufacture completeness.

## Changed files and preservation

Runtime changes:

- `src/common/types.ts`: optional typed search controls.
- `src/common/errors.ts`: fixed, safe validation messages.
- `src/providers/search/tavily/index.ts`: validated controls, conflict
  policy, request forwarding.
- `src/providers/processing/tavily_extract/index.ts`: validated
  optional format and forwarding; existing query/chunks validation
  retained.
- `src/server/tools/web_search.ts` and `web_extract.ts`: additive
  optional fields and provider-aware dispatch guards.

Regression/discovery changes:

- Both Tavily adapters' `index.test.ts` files.
- `src/server/tools/tavily_controls.test.ts`: actual MCP dispatch
  through real adapters with synthetic upstream responses.
- `src/server/evolution_discovery.test.ts`: compare P0 schema plus
  only the explicitly reviewed optional P1A additions.
- `src/server/fixtures/evolution-discovery/capture.mjs`: bounded
  `--p1a` verification of the installed build. P0 default retained;
  combining `--p1a` and `--update` is rejected.
- `src/server/fixtures/evolution-p1a/schema-additions.json` and
  README: actual captured additions and reproduction instructions.

Documentation: README usage,
[feature provenance](feature-provenance.md), this report and
[machine-readable evidence](search-gateway-evolution-p1a.json).

The worktree began clean. No overlap with uncommitted work existed. P0
JSON schema fixtures, P0 legacy response snapshots, HTML corpus, and
P0 reports remain byte-for-byte unchanged. Package manifests,
lockfiles, patch files, credentials, result-store implementation, HTTP
guard, launcher, and production files were not changed. The P0
report's uncommitted status is its historical validation snapshot; P0
was subsequently committed as `69e388a`.

## Validation results

Runtime: Node.js `v22.23.2`, Corepack-pinned pnpm `11.9.0`, Linux
ARM64 on the confirmed implementation host. Reused the existing
private-store/copy-import dependency installation from P0. No install,
upgrade, shared-store modification, or lockfile change was needed.

- Initial unchanged focused baseline: **35 passed in 5 files**.
- Search request forwarding was first observed failing against the
  hard-coded basic/general request, then passed after implementation.
- New direct-input/conflict validation first failed 11 cases; public
  search wiring first failed 9; extraction format first failed 5;
  public extraction wiring first failed 14 while the already supported
  whitespace-query case passed. Filtered-out tests in those
  deliberately narrow RED runs were not unfinished implementation.
- P0 discovery initially failed 4 expected assertions for the new
  fields. Instead of overwriting P0 fixtures, P1A now verifies the
  exact additions and checks the remaining contract against P0.
- Focused controls, adapters, discovery, and unchanged legacy
  envelopes: **109 passed in 5 files**.
- Full suite: **777 passed in 66 files**, zero failed/pending/TODO.
  This adds **46 tests** over P0's 731.
- Format/lint/types: passed. Build: passed, Node 22 target retained.
- Offline native HTTP smoke: **12 groups passed**. Includes both
  supported proxy protocol eras, auth/Host/Origin rejection, routes,
  discovery, cancellation-related existing tests, pagination and
  invalid-budget rejection. The smoke is not a live entitlement test.
- Built stdio P1A discovery: **four profiles passed** (14 tools with
  all fixture providers, 1 without providers, 13 without GitHub, 4
  Tavily-only). Negotiated direct-stdio protocol remains `2025-06-18`;
  the proxy tests the separate HTTP protocol contracts.
- ShellCheck and complete diff whitespace checks: passed.

Exact new property definitions were captured from the built server,
then compared with the installed Valibot JSON Schema conversion. All
original schema fields remain unchanged after removing only those five
known optional additions; there is no wholesale snapshot refresh. The
legacy large-result tests still reconstruct their original content and
citations through `result_read` with unchanged initial payloads.

No performance improvement is claimed. Provider latency, actual
billing, extraction quality and new-control behavior at live Tavily
remain **UNVERIFIED** because live calls were not authorized.

## Executed commands

Commands ran only in the isolated worktree with a sanitized
environment and temporary HOME/result directories. The run directory
is `/tmp/omnisearch-evolution-p1a-aTiykVBP`; the reused private
dependency store is `/tmp/omnisearch-evolution-p0-6eSLI6B1/store`.
These are local validation artifacts, not production configuration or
durable backups.

```bash
P1A_RUN=/tmp/omnisearch-evolution-p1a-aTiykVBP
P0_STORE=/tmp/omnisearch-evolution-p0-6eSLI6B1/store

env -i PATH="$PATH" HOME="$P1A_RUN/home" CI=true \
  corepack pnpm --config.store-dir="$P0_STORE" run check

env -i PATH="$PATH" HOME="$P1A_RUN/home" CI=true \
  corepack pnpm --config.store-dir="$P0_STORE" test -- \
  --reporter=json --outputFile="$P1A_RUN/final-tests.json"

env -i PATH="$PATH" HOME="$P1A_RUN/home" CI=true \
  corepack pnpm --config.store-dir="$P0_STORE" run build

env -i PATH="$PATH" HOME="$P1A_RUN/home" CI=true \
  corepack pnpm --config.store-dir="$P0_STORE" run test:smoke

env -i PATH="$PATH" HOME="$P1A_RUN/home" CI=true \
  node src/server/fixtures/evolution-discovery/capture.mjs --p1a

shellcheck start-server.sh
git diff --check
```

Focused RED/GREEN checks used installed `./node_modules/.bin/vitest`
with the same sanitized environment. The final focused command was:

```bash
./node_modules/.bin/vitest run \
  src/server/evolution_discovery.test.ts \
  src/server/tools/tavily_controls.test.ts \
  src/providers/search/tavily/index.test.ts \
  src/providers/processing/tavily_extract/index.test.ts \
  src/server/tools/evolution_tools.test.ts \
  --reporter=json \
  --outputFile=/tmp/omnisearch-evolution-p1a-aTiykVBP/controls-discovery.json
```

Only affected files were formatted. Complete tracked and added-file
diffs were inspected, and the exact staged paths must match the
validated snapshot before the approved local commit. No push, merge,
publication, or service-manager operation is part of this phase.

## Provenance, live checks, and remaining gates

The two pinned upstream Tavily commits and their actual MIT license
texts were inspected before adaptation. Current official API reference
GETs and retrieved-byte hashes are recorded in
[feature-provenance.md](feature-provenance.md) and the JSON report. No
paid search or extraction tool was needed for that public-document
inspection. Existing Scott Spence copyright and MIT notice remain.

**Deferred:** the rest of P1 (opt-in compact/full presentation,
request-level metadata, passage selection, canonical retention and
budget contract). Compact mode requires deciding whether the existing
single-principal boundary is acceptable or principal ownership needs
separately scoped work. P2 lifecycle/sanitization and P3-P6 remain
unimplemented in this phase.

**UNVERIFIED:** live Tavily controls, provider charges, historical
Context transaction identification and Firecrawl Agent live failures,
real extraction/worker safety/performance, new public-page staging,
and production rollout. `scripts/verify-live.mjs` was not invoked: no
approved live spend/time ceiling exists. Historical failure
characterizations were preserved, not represented as repaired.

No dependency was added. Defuddle, keyless extraction, automatic
routing, cache/fusion/crawl extensions, and branding were not touched.
P1A can be reviewed as a local source commit; it does not satisfy the
full P1 or release gate.

## Production preservation and rollback

Before/after integrity checks compared the live checkout's Git state,
tracked source and built artifacts, protected untracked file hashes,
process IDs/start times, listener state, and result metadata. They
remained unchanged. No production result contents were read, and no
credentials were copied or exposed. PM2 restart counters were not
queried; unchanged process identities are the recorded evidence.

There is no live rollout to undo. For later approved deployment, use
the existing deployment/backup procedures and restore a verified prior
artifact/configuration if needed. Do not reset the live checkout or
remove result state to roll back this isolated source change. P1A's
local commit is separately reversible; no history rewrite or
unapproved revert has been performed.
