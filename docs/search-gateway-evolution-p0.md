# Search gateway evolution: P0 baseline

Date: 2026-09-06. Scope: approved isolated P0 tests, fixtures, and
documentation only. **Local P0 complete; no feature release or
production enablement approved.**

Source revision: `047a7e1e3fce8451753e0e8bcffef6dcd13b4554`.
Implementation branch: `feature/search-gateway-evolution-p0-20260906`.
Implementation worktree:
`/home/ubuntu/worktrees/mcp-omnisearch-evolution-p0-20260906`.

The source checkout matched the proposal's baseline. This work adds no
production behavior, dependencies, package versions, lockfile changes,
credential configuration, aliases, routes, commits, or services. All
additions remain unstaged and uncommitted. Existing `.hermes/`,
`package-lock.json`, other worktrees, and generated production
artifacts were preserved.

## Verified local gates

The actual implementation host was `vnic-keiran`, Linux ARM64, using
Node.js `v22.23.2`, Corepack `0.34.6`, and repository-pinned pnpm
`11.9.0`. Source layout, repository guidance, deployment guidance,
package scripts, patches, and launcher/smoke behavior were inspected.
The new worktree began clean at the recorded revision.

- Frozen installation into an initially empty private store, with
  `--package-import-method=copy`: passed. Existing reproducible tmcp,
  stdio, and proxy patches were applied; no shared-store repair or
  package update occurred.
- Unchanged-source baseline: **673 tests passed in 61 files**, no
  failed, pending, or TODO tests.
- P0 final suite: **731 tests passed in 65 files**, no failed,
  pending, or TODO tests. The additions account for **58 tests**.
- Focused P0 tests: 58 passed; the final full run also verifies the
  subsequently renamed byte-preserving HTML fixture paths.
- Repository format/lint/type check and build: passed.
- Offline native MCP smoke: **12 groups passed**, covering liveness,
  readiness, authentication, Host/Origin restrictions, retired `/sse`,
  legacy and modern discovery, bounded validation errors, resource
  templates, UTF-8 pagination, envelope/header validation, batch
  rejection, and invalid budget rejection before networking.
- Built stdio schema verification: all four configuration profiles
  passed against captured JSON.
- `shellcheck start-server.sh`: passed. The launcher was not changed.
- Complete added-file diff and whitespace checks were reviewed; no
  tracked source/dependency changes or staged changes were present.

Machine-readable counts and payload observations are in
[search-gateway-evolution-p0.json](search-gateway-evolution-p0.json).
Full local command reports and private preservation manifests are in
`/tmp/omnisearch-evolution-p0-6eSLI6B1/`. That directory is an
ephemeral validation artifact, not a deployment backup or durable
evidence store. The reproducible fixtures and this report remain in
the implementation worktree. The installed isolated dependency tree is
retained for follow-on approved work.

## Reproduction commands and isolation

The following commands were exercised from the isolated worktree.
`P0_RUN` names the validation directory created for this run; a future
run must create a fresh private home/store rather than assume this
path persists. Package acquisition was the only intentional external
network use; no live provider tool was invoked.

```bash
P0_RUN=/tmp/omnisearch-evolution-p0-6eSLI6B1

env -i PATH="$PATH" HOME="$P0_RUN/home" CI=true \
  corepack pnpm install --frozen-lockfile \
  --store-dir "$P0_RUN/store" --package-import-method=copy

env -i PATH="$PATH" HOME="$P0_RUN/home" CI=true \
  corepack pnpm --config.store-dir="$P0_RUN/store" run check

env -i PATH="$PATH" HOME="$P0_RUN/home" CI=true \
  corepack pnpm --config.store-dir="$P0_RUN/store" test -- \
  --reporter=json --outputFile="$P0_RUN/final-tests.json"

env -i PATH="$PATH" HOME="$P0_RUN/home" CI=true \
  corepack pnpm --config.store-dir="$P0_RUN/store" run build

env -i PATH="$PATH" HOME="$P0_RUN/home" CI=true \
  corepack pnpm --config.store-dir="$P0_RUN/store" run test:smoke

env -i PATH="$PATH" HOME="$P0_RUN/home" CI=true \
  node src/server/fixtures/evolution-discovery/capture.mjs

shellcheck start-server.sh
git diff --check
git diff --exit-code
git diff --cached --exit-code
```

The last two commands confirm no modifications to tracked files or the
index; new additions are inspected separately with
`git status --short --untracked-files=all` and
`git diff --no-index -- /dev/null PATH`. They are not proof that
untracked work is absent. Added-file whitespace checking uses
`git diff --no-index --check -- /dev/null PATH` for each added file.

Focused execution used the installed local runner, with the same
sanitized environment, avoiding implicit package preparation:

```bash
./node_modules/.bin/vitest run \
  src/server/tools/evolution_tools.test.ts \
  src/server/evolution_discovery.test.ts \
  src/common/evolution_corpus.test.ts \
  src/common/evolution_results.test.ts \
  --reporter=default --reporter=json \
  --outputFile=/tmp/omnisearch-evolution-p0-6eSLI6B1/focused-tests.json
```

The provider fixtures use actual MCP dispatch and existing adapters,
with synthetic upstream HTTP responses, fixture keys, unexpected-call
rejection, and isolated result directories. No production credentials
were copied or loaded. Smoke instances use unused loopback ports and
temporary homes. Schema capture starts separate stdio processes and
blocks child `fetch` and `net.Socket.connect`. These controls are test
harnesses, not an OS sandbox or proof of Defuddle network isolation.

## Added files and acceptance coverage

- `src/server/evolution_discovery.test.ts`: 8 tests for all-provider,
  no-provider, missing-GitHub, and Tavily-only discovery; exact
  installed Valibot-to-JSON-Schema conversion; absent future controls;
  in-process stale registration; filesystem/result-directory privacy
  boundaries.
- `src/server/fixtures/evolution-discovery/`: four captured complete
  schema files, bounded built-stdio capture/verification script, and
  provenance/reproduction README. Capture defaults to verification;
  `--update` explicitly refreshes fixtures after review.
- `src/server/tools/evolution_tools.test.ts`: 35 tests across
  `web_search`, `web_extract`, `ai_search` with Tavily research, and
  `firecrawl_agent`. Each has success, provider failure, timeout,
  caller cancellation, invalid-input, and oversized-reconstruction
  coverage. Async tools additionally cover unknown IDs, state
  ambiguity, partial failures, status without repeat creation, and
  cancellation acknowledgement/readback. Plain search/extraction have
  no job IDs, so unknown-job handling is not applicable there.
- `src/server/tools/__snapshots__/evolution_tools.test.ts.snap`:
  observed legacy response/error envelopes and request options from
  synthetic provider fixtures, not purported live API responses.
- `src/common/evolution_results.test.ts`: 3 tests for the exact
  80,000-byte legacy tool-result boundary, missing below-threshold
  retention, and explicit failure when storage cannot retain evidence.
- `src/common/evolution_corpus.test.ts`: 12 corpus-integrity tests.
- `src/common/fixtures/evolution-html/`: eight original synthetic HTML
  documents, eleven fixed query cases, evidence anchors, SHA-256
  checksums, and MIT provenance. Cases cover article metadata,
  headings, code/fence text, tables/lists/math, CJK/Unicode, relative
  links with meaningful parameters, fragments, malformed HTML,
  challenge/empty pages, and inert hostile source content.
- This report and its JSON evidence summary.

Existing baseline suites still cover result TTL/eviction, physical and
logical quotas, compressed `.omr` retrieval, HTTP deadlines/retries,
request budgets, admission/cancellation, and transport security. See
`src/common/result_store.test.ts`, `src/common/results.test.ts`,
`src/common/http_resource_limits.test.ts`,
`src/common/request_context.test.ts`, and the existing server
transport/audit tests. P0 adds missing characterization rather than
rewriting those mechanisms.

## Source-grounded findings and P1/P2 prerequisites

1. **Tavily query already works publicly.**
   `src/server/tools/web_extract.ts` passes the query to
   `TavilyExtractProvider`; the new snapshot records the actual POST.
   `chunks_per_source` is adapter-supported but not public. Search
   still sends `search_depth: basic` and `topic: general`. Preserve
   those defaults while exposing validated optional controls in P1.

2. **Private result files are not per-client ownership enforcement.**
   `src/common/result_store.ts` uses a configured directory and opaque
   IDs; `src/common/request_context.ts` has no principal. The P0 test
   reads the same handle through two server instances sharing that
   directory, verifies directory/file modes 0700/0600, and confirms
   failure from a separate directory. This is not a demonstration of
   an unauthenticated network leak. Before P1, explicitly choose the
   existing single-principal deployment boundary or separately approve
   principal propagation and ownership enforcement. Do not advertise
   multi-tenant isolation.

3. **Compact mode needs forced retention, not only a lower
   threshold.** `handle_large_result` preserves full canonical JSON
   above its existing boundary, including compressed storage. Below
   the boundary it returns the supplied value without storing it.
   Passing only a selected passage would lose the omitted source. Its
   byte test covers the escaped MCP tool-result object, not outer
   JSON-RPC or HTTP/SSE framing. P1 must explicitly define budget
   scope.

4. **Cold-start and in-process registration differ.** Four cold-start
   profiles expose respectively 14, 1, 13, and 4 tools. Reinitializing
   after removing keys leaves stale singleton tools for GitHub, Brave
   LLM context/media/news, and Firecrawl Agent. Their initializers
   return false but do not clear the prior object. This is recorded as
   a baseline gap, not a desired reload contract. Configuration hot
   reload is not being introduced or repaired here.

5. **Direct stdio and proxied protocol support differ.** Built tmcp
   stdio negotiates `2025-06-18` when asked for `2025-11-25`. The
   offline proxy smoke separately passes `2025-11-25` and `2026-07-28`
   HTTP behavior. Future discovery and package tests must preserve the
   distinction instead of attributing proxy compatibility to direct
   stdio.

6. **Async partial/error semantics still need P2.** Synthetic failed
   Tavily/Firecrawl responses containing partial evidence lose that
   content. Tavily running status also omits provider partial text.
   IDs survive failure guidance, and status requests do not POST new
   jobs. Firecrawl DELETE acknowledgement maps to cancelled, but a
   later failed status remains an error; no message heuristic
   normalizes it. Unknown upstream states fail rather than becoming
   completion. At the direct server receive boundary, Tavily caller
   cancellation yields JSON-RPC `-32603` `Internal error`; other
   fixture paths expose cancellation tool errors. These are
   characterization results, not repairs.

7. **No parser performance or safety claim follows from P0.** The
   local corpus is ready, but no Defuddle dependency or local
   extractor was installed. Metadata anchors are human-authored
   expected evidence, not extracted output. P3 still needs controlled
   DNS/connection pinning, compressed/decoded streaming accounting,
   worker/resource limits, hard-boundary decisions, dependency and
   license review, packaged-worker execution, and approved staging.

## Measured legacy payloads

These are observations from the synthetic oversized fixtures, not
before/after improvements or production-load benchmarks. Each uses
`'P0 evidence 😀 漢\n'.repeat(6000)`. Initial byte counts include the
serialized JSON-RPC response. Canonical bytes refer to the provider
result serialized with two-space JSON formatting; readable stored
views may contain further duplication. Every fixture reconstructed its
entire content and preserved the tested source references.

- Web search: 722 initial bytes; 132,163 canonical JSON bytes; 12
  `result_read` calls.
- Web extraction: 826 initial bytes; 264,302 canonical JSON bytes; 35
  reads. Content is duplicated in the legacy `content` and
  `raw_contents` fields.
- Tavily research: 722 initial bytes; 132,522 canonical JSON bytes; 12
  reads.
- Firecrawl Agent: 837 initial bytes; 264,332 canonical JSON bytes; 46
  reads. The provider adapter also repeats data in metadata.

Extraction latency, relevance quality, peak memory, event-loop impact,
and compact-mode savings are **UNVERIFIED**. Mocked request timing is
not evidence of live extraction performance.

## Failed attempts, corrections, and historical evidence

- Initial cold-start tests reused the module graph and exposed stale
  provider singletons. The tests now separate fresh-module cold starts
  from an explicit stale-reinitialization characterization. Production
  code was not changed to make them pass.
- Initial built-stdio capture expected the proxy's newer legacy
  protocol. Actual negotiation was `2025-06-18`; the fixture assertion
  was corrected to record that observed boundary.
- Moving discovery from Vitest object snapshots to actual built-stdio
  JSON capture left obsolete generated snapshots. Only those newly
  created obsolete files were removed; the verification then passed.
- The first full check with `.html` corpus names failed because the
  formatter tried to repair intentionally malformed input. Raw files
  were renamed to `.html.fixture`, leaving their bytes/checksums
  intact. No formatter or runtime policy was weakened. The full gate
  passed after that fixture-only correction.
- Two delegated investigations timed out at the model API before
  writing implementation files. The parent completed and exercised the
  fixtures directly. Those timeouts were not source-test failures.
- The plan's historical provider outcomes were not reproduced live.
  Existing repository records describe different candidate snapshots;
  their pass counts are not substituted for this run. In particular,
  [verification-node24-live.md](verification-node24-live.md) contains
  historical Firecrawl lifecycle/cancellation observations and
  excludes other Context tools.
  [audit-remediation.md](audit-remediation.md) records later offline
  reliability work. Neither establishes current Context transaction
  readiness or repaired cancellation semantics.

## Deferred/excluded work and release disposition

- **UNVERIFIED:** historical Context transaction identification live
  failure and current Firecrawl Agent lifecycle/cancellation. The live
  harness `scripts/verify-live.mjs` was deliberately not invoked: no
  spend/time ceiling or live-call approval was provided. Synthetic
  fixtures do not repair or clear these live gates.
- **UNVERIFIED:** real provider entitlement, billing, live citation
  mappings, cross-principal result/job ownership, Defuddle extraction,
  performance, and staged public-page probes.
- **Deferred:** P1 runtime compact presentation and Tavily control
  wiring; P2 metadata/sanitization/lifecycle changes; P3 Defuddle; P4
  automatic routing; P5 optional providers/cache/fusion/crawl; P6
  branding and migration. No donor code was copied; donor revision,
  license and API verification remains a prerequisite before reuse.
- **Excluded from this native P0:** Docker image/runtime and
  additional Node versions. No Docker files or host runtime were
  changed.
- **Not authorized/performed:** Git commit, merge, push, publication,
  service restart, deployment, production enablement, endpoint rename,
  final brand selection, or destructive cleanup.

The P0 gate is satisfied locally: the reproducible baseline, protected
state, compatibility fixtures, corpus and known gaps are recorded.
This does not clear P1-P6 acceptance gates or authorize deployment.
The next smallest implementation slice is missing Tavily public
controls with legacy defaults preserved. Compact output additionally
needs an explicit privacy-boundary decision and canonical/budget
contract; these should not be silently decided by a passage selector.

## Preservation and rollback

Before and after the isolated checks, production Git state, source and
build file hashes, hashes of protected untracked `.hermes/` and
`package-lock.json` files, relevant process identities/start times,
listeners, and stored-result file metadata compared unchanged. No
production result content was read. PM2's restart counter was not
independently queried; unchanged process IDs and start times are the
recorded process evidence, not an invented counter reading.

No production rollback was required or attempted. Rollback of P0 means
leaving the isolated branch/worktree unused; removal of that worktree
or its artifacts is a separate action, not an automatic cleanup.
Existing shared Git history and the production checkout remain at the
recorded source revision. Test-owned temporary processes and result
directories were torn down; no production handle eviction or restart
was requested.
