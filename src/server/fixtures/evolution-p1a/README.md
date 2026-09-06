# P1A additive schema record

`schema-additions.json` contains only the five new optional properties
captured from the actual built P1A stdio server. All-provider,
missing-GitHub, no-provider, and Tavily-only profiles were compared
programmatically with the unchanged P0 JSON fixtures. No other
client-visible schema field changed in those profiles.

`src/server/evolution_discovery.test.ts` verifies these exact
additions, ensures they are not required, removes only these known
fields from a copy, and compares the remaining schema against P0. This
is not a blanket snapshot refresh that could hide unrelated
regressions.

After building the isolated worktree, verify the installed stdio path:

```bash
node src/server/fixtures/evolution-discovery/capture.mjs --p1a
```

The existing capture harness retains its P0 default. `--p1a` validates
the reviewed additions without writing P0 files; combining it with
`--update` is rejected. The fixtures contain synthetic configuration,
not credentials, live entitlement results, or provider API output.

Cross-provider use and conflicting option combinations are rejected by
runtime guards before provider dispatch; JSON Schema descriptions
label the fields Tavily-only. The schema remains convertible by the
installed Valibot adapter without changing its existing object shape.
