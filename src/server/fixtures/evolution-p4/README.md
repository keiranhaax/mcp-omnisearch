# P4 discovery delta

`schema-additions.json` records the optional input fields added after
the P1B delta, one entry per tool and field. Every field is optional
and additive: omitting it preserves the earlier behaviour. The
descriptions are the exact emitted descriptions, not paraphrases.

- `web_extract.screenshot`: Firecrawl actions mode only; opts back
  into the page screenshot that actions stopped returning by default.
- `web_extract.archive_fallback`: opt-in Wayback Machine recovery of
  pages the provider reports gone, read by the same provider.

## How it is checked

`src/server/evolution_discovery.test.ts` asserts each listed field is
present and not required, removes only these fields from a copy of
each cold-start discovery profile, and compares the rest with the
unchanged P0 JSON fixtures after the P1A and P1B subtractions. P0
fixtures and the earlier deltas are not refreshed, so an unrelated
schema change still fails.

`capture.mjs --workflow` and `--focused` apply this delta too when
verifying a built server from an approved isolated worktree. The
fixtures contain synthetic configuration only.
