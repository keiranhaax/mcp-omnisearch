# Node 24 and live-provider verification

Date: 2026-09-06. Candidate: `fix/reliability-audit-20260905`, based
on `37e19fe`, with uncommitted reliability fixes. No deployment or
commit.

## Runtime gate

- Official Node.js 24.20.0 Linux ARM64 archive from nodejs.org.
- SHA-256 matched the release's HTTPS SHASUMS256.txt:
  `5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7`.
- Separate temporary runtime, source copy, and empty private pnpm
  store; installed with the frozen lockfile and
  `--package-import-method=copy`.
- `corepack pnpm run check`: formatting, lint and types passed.
- `corepack pnpm test`: 477 tests passed across 46 files.
- `corepack pnpm run build`: passed, retaining Node 22 output target.
- `corepack pnpm run test:smoke`: all 10 groups passed on Node 24,
  including modern/legacy discovery and lossless UTF-8 pagination.
- System Node.js and the production dependency/cache configuration
  were not changed.

## Live tests

The candidate's real MCP stdio server ran under Node 24, using an
isolated home/result directory and the existing provider credentials
in memory. No credential file was copied or changed. A fetch wrapper
recorded endpoint/status/usage metadata and rejected requests outside
explicit method/endpoint/count allowances. No mocked provider response
was substituted for a live result. Public example.com/IANA/Node.js
fixtures only; no user content was sent to providers.

There were 18 MCP test cases: 16 clean passes and two flagged
cancellation outcomes described below. The harness observed 24
underlying provider requests. Read-only billing probes and one direct
cancellation readback were additional, separately recorded checks.

- Tavily: search with punctuation/Boolean syntax, extraction with
  query reranking, and async research completed. Research returned a
  short answer but `sources: []`; source citations were not verified.
- Exa: search, contents, answer with citations, and deep search
  passed.
- Brave Search: passed through the launcher's `BRAVE_SEARCH_API_KEY`
  alias; the canonical key is not directly present in the .env file.
- You.com: search passed with Bearer authentication.
- Context.dev: markdown scrape passed, reporting one credit consumed.
- Firecrawl: markdown plus requested JSON-format scrape returned
  content; Agent start and subsequent status returned completed Spark
  2 output. Both tested Agent jobs reported zero credits used.

### Cancellation outcomes

1. Completed job `01a07473-f3b2-70ad-8227-1a9154d67c61`: DELETE
   returned 409, correctly exposed as `isError:true`. The generic
   harness expected success and marked this FAIL, but official docs
   define 409 for a job already finished. Status readback remained
   completed. This is expected provider behavior, not a cancellation
   success.
2. Running job `01a07476-34c4-7369-baaf-da28c8018156`: DELETE returned
   200/success; Omnisearch returned cancelled. A later GET returned
   HTTP 200, `success:true`, `status:failed`,
   `error:"Refusal: Error: Agent was cancelled"`, and `creditsUsed:0`.
   Omnisearch correctly treated failed as an MCP tool error and
   retained the job ID, but did not normalize it to cancelled.
   Provider termination is confirmed; a clean cancelled-status round
   trip is not. No runtime fix or message-based status heuristic was
   added in this verification-only scope.

## Spend accounting

User authorization: $5 total. Internal reserved allowance: $3.676.
This allowance is a planning ledger, not a provider-enforced billing
cap. Requests and job creation were bounded; automatic paid retries
were blocked by endpoint allowances. Each Agent creation explicitly
sent `max_credits:100`. Existing balances were checked before the
respective paid checks where a balance endpoint was available.

Observed usage:

- Exa: $0.025 total, from response `costDollars` fields.
- Firecrawl balance: 14,448 to 14,443 credits; five credits consumed.
  Both Agent status responses reported zero credits. At the highest
  published self-serve paygo rate ($0.005/credit), five credits have a
  $0.025 consumption value; this is not a cash invoice assertion.
- Context.dev: one credit; remaining 30,242 to 30,241. Existing
  credits covered the test, without reaching an overage block.
- You.com: balance endpoint moved from 19,972 to 19,971 cents. The
  published base search price is $0.005; rounding/concurrent account
  activity prevents treating the one-cent delta as exact attribution.
- Brave Search: one request; published base rate $0.005. No per-call
  billed-cost field was captured.
- Tavily: published search/extract reserve $0.024, research reserve
  $2.00 (250-credit maximum at $0.008/credit). Usage remained at 23
  credits with `research_usage:0` after completion; exact attribution
  and final billing are unverified. Do not claim the research was
  free.

No new credits, subscriptions, billing settings, or account limits
were changed. Automatic top-up settings were not independently
inspected; a complete final cash-charge total is therefore not
certified from these observations. Paid calls were stopped after the
bounded cases above.

## Not exercised

- Brave Answers: variable internal input-token/search costs had no
  verified request-level USD cap; account spending controls were not
  available through the inspected local configuration. Skipped.
- Firecrawl `/extract`: no documented hard token/credit cap. Skipped.
- Firecrawl live crawl pagination/search/actions and the other Context
  tools were not exercised. Their mocked regression coverage is
  separate.
- Linkup: no configured key in the inspected environment. GitHub's
  separate shared credential source was not loaded for this paid
  suite.
- Docker image/runtime: still unverified because the daemon is
  unavailable.

## Evidence and reproduction

- `verification-node24-live.jsonl`: append-only case reservations,
  response summaries/hashes, account observations, and raw-status
  classification.
- `verification-node24-live.jsonl.requests.jsonl`: endpoint attempts,
  HTTP statuses, provider job/request IDs and reported usage, no
  headers.
- `verification-node24-live-plans.json`: public fixture plans used.
- `../scripts/verify-live.mjs`: explicit opt-in harness. It does not
  run with `pnpm test`, and a completed/reserved case ID is not
  reissued. Re-running with fresh IDs spends money and requires
  renewed approval. Plans are not authoritative price or security
  policies; review provider caps and account billing settings before
  another run.

The first live harness invocation failed before provider dispatch due
pnpm dependency-path resolution; it was corrected to resolve the real
package location. No paid request was repeated for that failure.

## Production integrity

Production guard PID 3153 and proxy PID 3189, zero PM2 restarts,
tracked source/build hashes, and metadata for 12 production result
files were unchanged across this run. Direct and public `/ping`
returned `pong`. No production source, service, credential, or
configuration changes. The temporary runtime/source/store and test
homes were removed, and the shell was restored to system Node 22. The
harness also passed offline rejection/no-repeat checks with provider
fetches blocked.
