# Fixed search evaluation set

`manifest.json` is a human-authored set of 25 queries across docs,
code, news and general topics, each with anchor URLs or domains that
count as a correct result. The anchors are expectations written on the
`authored_at` date, not provider output; sites move, so refresh an
anchor when a miss is the anchor's fault rather than the provider's.
The file is covered by the repository's MIT license.

`synthetic-run.json` is a recorded run in the format the scorer reads,
built from the manifest with made-up ranks, latencies and usage so the
scoring tests have known answers. It is not provider output and makes
no claim about any provider.

`scripts/eval-search.mjs` scores a run per provider: hit@1, hit@5,
mean reciprocal rank, latency and provider-reported cost, overall and
per category. Offline scoring needs only a run file. Live mode runs
only with `--live` and explicit per-run budgets, drives the built
server through the normal `web_search` path so spending caps,
cooldowns, metrics and budgets all apply, and bounds requests with the
same guard `scripts/verify-live.mjs` uses. Reports go to the ignored
`reports/eval/` directory. See the README section "Search evaluation"
for the commands.

A run record is
`{ query_id, provider, status, urls, latency_ms, usage, error_kind? }`.
`provider` is any label, so a fused run such as `fused:tavily+exa`
scores beside the single providers it combines.
