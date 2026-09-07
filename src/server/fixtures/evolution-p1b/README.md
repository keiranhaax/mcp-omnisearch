# P1B discovery delta

`schema-additions.json` contains only `response_mode` and
`output_budget_bytes` for `web_search` and `web_extract`. Both are
optional. The response modes are `legacy`, `compact`, and `full`; the
budget is an integer from 2048 through 80000. Descriptions are the
exact emitted descriptions, not paraphrases.

## Capture provenance

Captured from the installed `ValibotJsonSchemaAdapter.toJsonSchema`
using actual `register_tools` definitions, and checked against
`create_server().receive({ method: 'tools/list', ... })`. A temporary
reporting test in `evolution_discovery.test.ts` printed the two
properties from each converted schema. That reporting test was removed
after capture; normal regression tests remain read-only.

P0 discovery JSON and the P1A delta were not refreshed. Current tests
check the exact optional P1A and P1B additions, subtract only those
properties, and compare the rest of each cold-start discovery profile
with P0. The separate P1B assertion fixes the allowed tool and field
names so expanding the delta cannot silently permit other additions.

## Focused evidence

All test commands used the installed runner without installs or
provider calls:

```sh
env -i PATH="$PATH" \
  HOME=/tmp/omnisearch-evolution-p1b-HF26M2ho/home CI=true \
  ./node_modules/.bin/vitest run src/server/evolution_discovery.test.ts
```

- RED before discovery edits: 4 failed, 4 passed. The all-provider,
  no-GitHub, and Tavily-only comparisons rejected the two new fields;
  the old compact-absence assertion also failed.
- RED after adding phase-guard tests, before changing `capture.mjs`:
  append `-t 'built discovery capture phase guards'` to the command.
  Two P1B cases failed because `--p1b` was unrecognized; the existing
  P1A update guard passed.
- Adapter capture: append
  `-t 'reports the installed-adapter P1B schema delta for capture'`
  while the temporary reporting test was present. One passed and
  printed the exact delta.
- GREEN after the update: 11 discovery/phase-guard/privacy tests
  passed. Scoped `vp check --fix` passed formatting, lint, and types.
- Final focused evolution run: the command above plus
  `src/server/tools/evolution_tools.test.ts`,
  `src/common/evolution_results.test.ts`, and
  `src/common/evolution_corpus.test.ts` passed 61 tests in 4 files.
  `node --check` passed for `capture.mjs`.
- All 18 tracked fixture/snapshot files under `src`, excluding the
  deliberately modified capture script, matched their HEAD bytes.

## Built-server verification

After the parent builds the integrated source, run this read-only,
network-blocked capture gate:

```sh
env -i PATH="$PATH" \
  HOME=/tmp/omnisearch-evolution-p1b-HF26M2ho/home CI=true \
  node src/server/fixtures/evolution-discovery/capture.mjs --p1b
```

`--p1b` includes both phase deltas. `--p1a` still permits only P1A; no
phase flag still verifies P0. Phase flags cannot be combined with each
other or `--update`. The integrated parent build and this gate passed
all four profiles, with no provider networking.

The additional positive-path proof uses synthetic Tavily responses and
blocks socket networking:

```sh
env -i PATH="$PATH" \
  HOME=/tmp/omnisearch-evolution-p1b-HF26M2ho/home CI=true \
  node src/server/fixtures/evolution-p1b/smoke.mjs
```

It passed compact/full 2048-byte budgets and exact canonical recovery
through `result_read`, plus invalid-control rejection before an extra
mock fetch. This is not production deployment or live-provider
evidence.
