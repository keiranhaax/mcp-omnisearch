# Search gateway evolution: P3A controlled fetch boundary

Implementation checkpoint, before commit/build staging: 2026-09-07.
Base commit: `c188f5d1f21337cee3ff877b41371bfeebdc4c1d`. Worktree:
`/home/ubuntu/worktrees/mcp-omnisearch-evolution-p0-20260906`. Changes
are uncommitted and unstaged. This is the local fetch slice, not
completion or production enablement of P3/Defuddle.

## Approved scope and compatibility

The user approved P3A only: controlled fetching, address policy,
resource/error support, offline tests, and evidence/provenance. No
dependency installation, parser, tool registration, provider request,
configuration change, commit, publication, deployment, or service
restart was authorized or performed.

Existing provider HTTP, URL validation, retry, registration, metadata,
presentation, result storage, and retention contracts remain in use.
No existing provider is routed through this fetcher. The shared
trusted-client privacy boundary is unchanged.

## Implementation

- `src/common/public_address.ts`: strict HTTP(S) URL/authority checks,
  ports 80/443, canonical IPv4 notation, and Node BlockList CIDR
  classification. IPv6 requires a reviewed IANA allocation to a RIR,
  not merely membership in `2000::/3`. Special-purpose, mapped,
  translation, transition, metadata and local destinations fail
  closed. Some globally reachable special-purpose addresses are
  deliberately excluded. Future allocations require review.
- `src/common/safe_fetch.ts`: one operation-owned DNS resolver; both
  A/AAAA queries settle; any non-public answer rejects the target. An
  approved address is supplied to the actual request lookup with
  family selection fixed. Each connection is new; socket peer identity
  is checked. The original hostname remains the HTTP/TLS identity,
  with certificate verification enabled.
- Redirects are manual. Raw authorities are validated before URL
  normalization can hide empty userinfo or numeric-IP variants. Each
  hop resolves and pins again. HTTPS downgrade, unsafe targets,
  excessive redirects, upgrades and excessive informational responses
  are rejected. No cookies, credentials, environment proxy routing,
  caller headers, automatic retries or provider fallback are used.
- Response handling separately counts plaintext HTTP bytes before
  parsing removes headers/chunk framing, encoded body, decompressed
  body, and transcoded UTF-8 bytes. Gzip, zlib-wrapped deflate, Brotli
  and identity are supported; stacked/unknown encodings are not.
  Content-Length is an early rejection aid, not the streaming limit. A
  fixed output buffer avoids accumulating unbounded tiny-chunk arrays.
  Existing request-wide decoded-response accounting is reused. Header
  count truncation is disabled within the byte cap so late duplicate
  critical headers cannot hide. Trailing compressed junk is rejected.
- HTML/XHTML MIME is required. Charset comes from the HTTP header or
  Unicode BOM, defaulting to strict UTF-8. Conflicting declarations,
  unsupported labels and malformed encoded text fail explicitly. MIME
  parameters are parsed completely, including quoted delimiters. This
  is not browser encoding detection: HTML meta-only charset sniffing
  and extraction-quality decisions are not implemented here.
- Queue, DNS, connect/TLS, headers, body and consumer run within an
  overall deadline. DNS cancellation is operation-local. Sockets and
  streams are destroyed on failure; the request close event is awaited
  before releasing capacity.
- Native decoder work also holds capacity: HTTP cancellation does not
  destroy a decoder with a pending native operation. One write runs at
  a time; synchronous output checkpoints stop further native steps on
  cancellation/limits. Native format errors settle pending writes.
  After input ends, natural readable completion/error is awaited
  before finalizing text, validating consumed bytes, or destroying the
  decoder. Writable completion alone is insufficient. Production code
  uses public stream APIs, not async hooks or private zlib internals.
  A deadline requests cancellation; native settlement can outlast it.
  This is not a hard CPU/memory or process-isolation boundary.
- `with_local_fetch_slot` reuses existing admission/queue code with a
  local-fetch limit and fixed byte reservation. Its callback API holds
  the lease through processing, not merely response receipt. Consumers
  must obey cancellation and not retain input beyond their lease. P3B
  must supply terminable parsing; a synchronous parser is not made
  interruptible by this API.
- Local failures have fixed safe messages and non-retryable reason
  codes. No fetched URL, resolved address, raw upstream exception,
  response headers or page excerpt is attached to diagnostics.
  Existing public error kinds are reused.

## Candidate limits and measurements

These are local implementation candidates, not approved production
configuration or demonstrated process-memory limits.

| Control                                         | P3A candidate           |
| ----------------------------------------------- | ----------------------- |
| Encoded / decompressed / UTF-8 text             | 5 MiB each              |
| Plaintext HTTP bytes, including framing         | 6 MiB per hop           |
| Response headers                                | 16 KiB per response     |
| Redirects / informational responses             | 5 / 4                   |
| DNS answers                                     | 32 across A/AAAA        |
| Total deadline, including queue and consumer    | 20 seconds              |
| DNS / connect-TLS / headers / body-idle         | 3 / 5 / 5 / 3 seconds   |
| Active local fetch / waiting queue, per process | 1 / 8                   |
| Admission reservation                           | 32 MiB per active lease |

Encoded-byte accounting is the compressed HTTP body after HTTP
transfer framing; the separate HTTP counter includes that framing,
headers and informational responses. Neither counts TCP/TLS overhead.
Per-hop caps are additionally bounded by the redirect/total deadline;
returned counters describe the final response, not aggregate traffic.
The reservation is an admission model, not accounting for every native
decoder/GC allocation, a DOM budget, or an enforceable RSS ceiling.
Deployment-specific NAT64 or routing may need OS egress restrictions
beyond address classification.

The final focused passing run streamed 4,194,007 bytes with exact
SHA-256 content recovery in 79 ms. An independent 1 ms interval
progressed 71 times; the sampled event-loop maximum was 10.068 ms.
Sampled RSS increase was 12,582,912 bytes and external-memory increase
was 6,095,261 bytes. These include fixture/runtime noise and are not
portable performance thresholds or a worst-case allocation proof. No
intentional OOM or uncontained hostile-parser stress was run.

## Verification

Node `22.23.2`, installed Vitest `4.1.10`, existing Vite+ binaries.
All execution used cleared environments and temporary test homes.

- Focused fetch gate: 82 tests passed, including final-flush checks.
- Four affected test files: 750 passing tests in the final report.
- Full gate: 1,779 tests in 74 files passed; zero failed or pending.
- Format/lint/types: passed; zero warnings/errors.
- Node 22-target build: passed, only in the worktree.
- Native HTTP smoke: 12 groups passed.
- Built discovery: all-provider 14, no-provider 1, no-GitHub 13,
  Tavily-only 4; no schema change or network attempt.
- P1B and P2 built recovery smokes: exact canonical reconstruction
  remained green, including partial failures and sanitized evidence.
- ShellCheck on the unchanged launcher and `git diff --check`: passed.

New coverage includes CIDR edges, special-use hosts, alternative IP
notation, mixed DNS and rebinding, redirect policy, TLS trust/name
failure, peer mismatch, framing, byte limits, compressed expansion,
charsets, stage deadlines, cancellation, saturation and lease cleanup.
Socket fixtures use unused loopback ports with test-only transport
injection; DNS is injected/mocked. Production has no allow-private
setting. TLS fixture keys are synthetic, generated under a temporary
directory and removed after tests.

Observed regressions during implementation included missing lease
behaviors, raw-redirect normalization bypasses, an informational
response rejection race, late-header truncation, malformed MIME
acceptance, ignored compressed trailing data, and uncounted HTTP
framing. Independent review also found native-decoder work outliving
stream closure and final-flush validation. Six final-flush/truncation
regressions (gzip, deflate, Brotli) were observed failing before the
fix, then passing. Earlier passing broad gates predate those fixes;
only the final report below describes the completed source.

Native-callback tests use test-only async hooks and documented
Transform extension points, with small finite synthetic thread-pool
jobs to expose premature lease release. No native instrumentation is
imported by the fetcher. A first bridge revision hung on native format
errors that did not call the write callback; handling the decoder
error event fixed that failure, and malformed-input tests pass.

Reproduce with the already prepared dependencies; do not run install
or permit package-manager auto-repair:

```bash
set -euo pipefail
P3A_RUN=$(mktemp -d /tmp/omnisearch-p3a-XXXXXX)
mkdir -p "$P3A_RUN/home"
env -i PATH="$PATH" HOME="$P3A_RUN/home" CI=true ./node_modules/.bin/vp check
env -i PATH="$PATH" HOME="$P3A_RUN/home" CI=true \
  ./node_modules/.bin/vitest run --reporter=json --outputFile="$P3A_RUN/tests-final.json"
env -i PATH="$PATH" HOME="$P3A_RUN/home" CI=true ./node_modules/.bin/vp pack
env -i PATH="$PATH" HOME="$P3A_RUN/home" CI=true node scripts/smoke-mcp.mjs
env -i PATH="$PATH" HOME="$P3A_RUN/home" CI=true \
  node src/server/fixtures/evolution-discovery/capture.mjs --p1b
env -i PATH="$PATH" HOME="$P3A_RUN/home" CI=true \
  node src/server/fixtures/evolution-p1b/smoke.mjs
env -i PATH="$PATH" HOME="$P3A_RUN/home" CI=true \
  node src/server/fixtures/evolution-p2/smoke.mjs
shellcheck start-server.sh
git diff --check
```

The final JSON test report is
`/tmp/omnisearch-p3a-gate-yNfmVZ/tests-final.json`; the durable
summary is [P3A JSON evidence](search-gateway-evolution-p3a.json). The
temporary directory is test output, not a rollback backup.

## Production, remaining gates and rollback

Production remains at P2 commit `c188f5d`. Its four artifact hashes
still match the preceding P2 checkpoint, the preceding guard PID still
exists, and the original dirty/untracked path list remains. No
production build, restart, cleanup or retention change occurred. The
previously expired 16 results remain outside the P2 build backup's
recovery scope; this work makes no new recovery claim.

UNVERIFIED/deferred: Defuddle dependencies/imports, parser termination
and auxiliary-network denial, packaged worker, P3 evidence
integration, public-page staging, production egress/memory containment
and final operating thresholds. P3B/P3C need separate approvals. P3A
does not emit a fetch/parser worker in the production package because
it is not registered or imported by the server.

Live-provider entitlement/billing, citation fidelity, Firecrawl
lifecycle/cancellation and Context transaction identification remain
deferred with zero provider calls. No CI workflow or GHCR setting was
changed; uncommitted local work is not a hosted CI result. The prior
P2 missing-CI-run finding remains unresolved. P4 opt-in routing, P5
optional extensions and P6 independent naming/migration remain the
roadmap, not additions to this scope.

There is no production rollout to undo. A future approved rollback of
P3A must target only this reviewed worktree diff and its generated
build output, preserving any later work. Do not reset production,
remove user files or restore result data from a build backup.

## Subsequent commit/build-staging authorization

After the implementation checkpoint above, the user requested:
"Commit, stage build into current". The approved follow-up commits P3A
and stages matching source/build artifacts in `/opt/mcp-omnisearch`,
preserving local edits and data. It does not authorize a push,
dependency installation, service restart, or Defuddle enablement.

The later promotion receipt is
`/home/ubuntu/backups/mcp-omnisearch-p3a-20260907-EFIkoK/RESULT.md`,
with the pre-promotion fingerprint and verified build/document backup
beside it. Read that receipt for the completed commit/staging state;
the uncommitted and unchanged-production statements above describe the
earlier implementation checkpoint, not the later promotion.
