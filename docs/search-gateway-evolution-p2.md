# Search gateway evolution: P2 metadata and lifecycle

Date: 2026-09-07. Base: `c86e955fe8d5687b62e576b4b46ea2ebf3465d71`
(locally committed P1B). P2 source implementation and offline
validation are complete, with an uncommitted, unstaged diff in
`/home/ubuntu/worktrees/mcp-omnisearch-evolution-p0-20260906`, branch
`feature/search-gateway-evolution-p0-20260906`. The P1B report remains
a historical pre-commit checkpoint, not the current Git state.

## Scope and preservation

The user approved P2 metadata, typed errors, Tavily Research/Firecrawl
Agent lifecycle recovery, provider-control sanitization, tests, and
documentation. Work used prepared dependencies on verified host
`vnic-keiran`, Node `v22.23.2`. No installs, staging, commits, merges,
pushes, paid/live provider calls, production writes, deployment, or
service/configuration changes were performed.

The shared trusted-client boundary approved in P1B remains. All
clients sharing the instance and result directory share result/job
access. Opaque IDs, UUID validation, and file permissions are not
per-client ownership checks. There is no persistent job registry, new
identity propagation, fallback provider, or automatic replacement job.

## Implemented contract

### Request metadata and errors

The existing WeakMap metadata now accepts safe Exa request IDs and
`costDollars.total` as `{usd}`, Tavily reported timing/credits,
Firecrawl Agent `creditsUsed`, and typed job observations. Numeric
strings are not coerced. Zero is valid; absent or malformed usage is
`null` with `usage_source: unknown`. No usage flag or estimated cost
was added to provider requests.

`ai_search` and `firecrawl_agent` handlers return `_meta.omnisearch`
with provider, action as operation, measured elapsed milliseconds,
usage provenance/scope, local completeness, and job/error metadata
where applicable. Elapsed time covers local dispatch and provider
wait, not network latency alone or final serialization. Job usage is
the reported observation, never a sum over polls. Exa metadata also
feeds the existing compact/full `web_search` and `web_extract`
envelopes. Existing safe legacy metadata is not removed solely to
deduplicate it.

Error kinds are `authentication`, `entitlement`, `rate_limit`,
`timeout`, `cancelled`, `endpoint_mismatch`, `bad_input`,
`storage_failure`, and `upstream_failure`. Only bounded provider/ID
fields and valid numeric HTTP statuses are exposed. `retryable`
mirrors the existing predicate; it does not authorize replaying paid
creation. Health gains `last_error_kind`, clears it on success, and
does not degrade for local cancellation or retention failure. Generic
failures do not disable registration or credentials. Shared HTTP and
retry implementations are unchanged.

### Job observations and evidence

| Typed state | Tavily Research status                                 | Firecrawl Agent status                    |
| ----------- | ------------------------------------------------------ | ----------------------------------------- |
| `queued`    | `pending`                                              | `queued`                                  |
| `running`   | `in_progress`                                          | `scraping`, `processing`                  |
| `completed` | `completed` with report content                        | `completed` with data                     |
| `failed`    | `failed`, `error`                                      | `failed`, `error`, or `success: false`    |
| `cancelled` | Not supported                                          | `cancelled` or acknowledged cancellation  |
| `unknown`   | Unrecognized/malformed observation or interrupted wait | Same; also creation acknowledgement alone |

`provider_status` preserves only a bounded safe status string. Unknown
states are not completion. A missing required completion payload fails
with recovery information. Optional malformed measurements do not
discard otherwise valid evidence. Valid start IDs survive malformed
non-identity fields. Firecrawl's legacy start body still says
`processing`; the typed observation is `unknown` with no invented raw
provider status.

`partial: true` identifies unfinished report evidence. The latest
usable evidence survives subsequent failed, unknown, or malformed
observations within one bounded wait. Tavily sources-only failure or
malformed completion does not erase earlier report text. Firecrawl
retains earlier data if later observations omit it. This is not a
cross-request history or an attempt to merge all historical snapshots.
Fresh status requests rely on what the provider returns. Existing
adapter result limits still define the canonical result.

Status/resume is GET-only and never creates a replacement job.
Firecrawl cancellation is DELETE-only; `success: true` acknowledgement
or a cancelled status confirms cancellation. Rejection, unsupported
cancellation, or ambiguous response leaves cancellation `unconfirmed`
and state `unknown`. Local wait cancellation does not cancel the
remote job. Tavily does not gain a cancel action. Pre-ID Tavily
cancellation and other AI providers retain their existing abort
propagation.

Accepted-job failures retain `isError: true` with JSON text
`{error, job, result?}`. The optional result is inline evidence or a
bounded `result_read` handle. Errors before a known ID keep plain safe
text; schema/protocol rejection before a handler is unchanged.
Firecrawl acknowledged cancellation is a successful observation, not
an execution failure. Both async wrappers cap the serialized MCP tool
result at 80000 UTF-8 bytes, including `_meta`, escaped text, and
`isError`, excluding JSON-RPC framing.

Local completeness means `complete` for inline observed evidence,
`retained` for offloaded evidence, or `unavailable` after retention
failure. It does not assert job/page completeness. Storage failures
keep the job ID and recovery guidance, expose no evidence body or
false handle, and do not masquerade as upstream outages. Partial
evidence never enters generic `error.details` or provider-health logs.
The existing bounded store, readable legacy view, canonical JSON,
`result_read`, quotas, expiry, and eviction remain in use.

### Provider-owned metadata sanitization

All five Exa adapters project supported control fields: bounded
request IDs/search modes, finite cost categories, safe content
statuses, and known grounding/citation fields. Firecrawl scrape
projects document and page metadata and replaces raw warning text with
a fixed warning. Provider-owned headers, configuration, unknown
diagnostic siblings, and raw exception bodies are excluded before
inline output or storage. Tavily Research and Firecrawl Agent retain
their validated evidence fields and sanitize optional operational
fields.

Source strings, meaningful URLs, citation IDs, code/math, and
extracted structured values named `token`, `api_key`, `headers`, or
`config` remain evidence. This is not blanket recursive key removal,
arbitrary secret detection, or HTML sanitization. Retrieved
instructions remain untrusted. No source content is executed.
Unsupported control fields may be omitted even in legacy mode; this is
an intentional P2 change.

## Verification

The unchanged P1B baseline passed **908 tests in 70 files**. Final P2
passed **1119 tests in 72 files**, with zero failures or pending
tests. Format/lint/types, build, ShellCheck, and whitespace checks
passed.

Observed RED evidence, not inferred coverage:

- Initial lifecycle regressions: 12 failures.
- Typed errors/health: 84 failures and 66 passes, then 150 passes;
  retry/resource compatibility: 49 passes.
- Sanitization: 33 failures and 49 passes, then 132 passes.
- Independent-review regressions: 9 failures and 18 passes; fixes
  addressed unsafe status text, retention-failure recovery, malformed
  start IDs, lost earlier Agent evidence, and full-envelope overhead.
  The subsequent focused integration run passed 203 tests.
- Additional regressions covered two storage classification/health
  failures and two job-observation failures. Final review reproduced
  one Tavily sources-only completion failure; the corrected focused
  provider/lifecycle run passed 62 tests. Filtered RED tests are not
  unfinished work.

An early full suite had 1111 passes and three obsolete cancellation
expectation failures. Pre-ID abort behavior was preserved and
accepted-ID expectations were updated to the new recovery contract.
The first P2 built smoke reached its final call-count assertion but
had a harness regex error; its corrected counting assertion and final
rerun passed. These intermediate results are not the final gate.

Final built-artifact gates:

- **12 offline native HTTP smoke groups passed**, covering both proxy
  protocol eras, auth/Host/Origin, routes, schema/input validation,
  resource dispatch, and lossless bounded pagination.
- **Four discovery profiles passed**, with 14 all-provider tools, 1
  no-provider tool, 13 without GitHub, and 4 Tavily-only tools. No P2
  tool-name/input-schema delta. Direct stdio negotiates `2025-06-18`;
  proxy HTTP compatibility is verified separately.
- P1B built compact/full smoke remained green: **1879/775 bytes**
  under 2048, exact canonical reconstruction in two reads each.
- P2 built smoke reconstructed failed Tavily/Agent evidence exactly in
  **20/78 reads**. Sanitized Exa/Firecrawl compact results were
  **1779/1698 bytes** under 2048, reconstructed in **20/39 reads**.
  Source code/math/Unicode and structured evidence fields survived;
  control canaries were absent from responses, retained results, and
  captured stderr. Exactly six synthetic fetches, one Agent POST, and
  zero real provider calls.

These are synthetic correctness measurements, not live relevance,
latency, provider billing, or savings claims. The built smoke mocks
only fetch, blocks socket networking, launches actual `dist/index.js`,
and reads retained data through the public tool.

### Historical fixture disposition

All 22 tracked fixture/snapshot/harness files remain byte-identical to
P1B HEAD. The P0 snapshot file retains SHA-256
`8f1bd0f833e1590964c79c19079c9529da0eec30413b74935ed4453ae31ac2be`.
Eight snapshots still use ordinary matching. Ten superseded
error/lifecycle snapshots remain archived unchanged; their tests first
assert explicit P2 behavior, verify the snapshot checksum, then mark
the historical entry checked using the installed Vitest snapshot API.
No snapshots were refreshed, deleted, or accepted blindly.

Those ten cases cover authentication/cancellation recovery, unknown or
foreign job IDs, pending partial reports, failed partial reports, and
Agent cancellation/readback. Synthetic foreign-ID errors do not prove
per-client ownership. P1A/P1B discovery deltas and HTML fixtures are
unchanged. Package/lockfiles, transport, configuration, and
result-store implementation are also unchanged.

## Reproduction and evidence

Used installed binaries directly to avoid package-manager auto-repair.
Temporary reports are under `/tmp/omnisearch-evolution-p2-PsHVP7aD`;
durable outcomes are in the
[JSON evidence](search-gateway-evolution-p2.json). This directory is
validation output, not a backup. From the isolated worktree:

```bash
set -euo pipefail
P2_RUN=$(mktemp -d /tmp/omnisearch-p2-XXXXXX)
mkdir -p "$P2_RUN/home"
env -i PATH="$PATH" HOME="$P2_RUN/home" CI=true \
  ./node_modules/.bin/vitest run --reporter=json \
  --outputFile="$P2_RUN/tests.json"
env -i PATH="$PATH" HOME="$P2_RUN/home" CI=true ./node_modules/.bin/vp check
env -i PATH="$PATH" HOME="$P2_RUN/home" CI=true ./node_modules/.bin/vp pack
env -i PATH="$PATH" HOME="$P2_RUN/home" CI=true node scripts/smoke-mcp.mjs
env -i PATH="$PATH" HOME="$P2_RUN/home" CI=true \
  node src/server/fixtures/evolution-discovery/capture.mjs --p1b
env -i PATH="$PATH" HOME="$P2_RUN/home" CI=true \
  node src/server/fixtures/evolution-p1b/smoke.mjs
env -i PATH="$PATH" HOME="$P2_RUN/home" CI=true \
  node src/server/fixtures/evolution-p2/smoke.mjs
shellcheck start-server.sh
git diff --check
```

Fixtures use synthetic credentials and isolated result directories.
Built smokes tear down their own children and temporary homes. No
production process, dependency tree, or result data is used for tests.

## Production and remaining gates

Production checkout remains
`047a7e1e3fce8451753e0e8bcffef6dcd13b4554`, with unrelated existing
documentation edits and untracked files preserved. No production
build/restart, merge, push, or deployment occurred. Source HEAD alone
does not establish the identity of running production artifacts; a
full live-state audit was not part of P2.

**UNVERIFIED:** live provider entitlement, billing, citation fidelity,
current Firecrawl Agent lifecycle/cancellation, and the historical
Context transaction-identification failure. Synthetic P2 recovery
tests do not clear these live gates. `scripts/verify-live.mjs` was not
run; it requires separate approval and spend/time ceilings.

No normalized cross-provider cache status, attempted-provider ledger,
automatic routing, or persistent lifecycle database was introduced.
Safe cache hints remain provider-specific when available. Defuddle,
controlled fetching, later routing/cache phases, and branding remain
outside P2. Per-client isolation is deliberately absent, not
validated.

Next checkpoint: review and, only if separately requested, locally
commit this P2 diff. Deployment and P3 require their own scope
approval. There is no live rollout to undo; do not reset production or
delete result state to roll back isolated development.
