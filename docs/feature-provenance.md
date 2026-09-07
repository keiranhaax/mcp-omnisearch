# Feature provenance

## P1B: local presentation and request metadata

Implemented independently against the fork's existing contracts. No
code, test bodies, or dependencies were copied from the proposed
passage-selector or metadata donors. Existing MIT notices remain.

- `src/common/presentation.ts`: opt-in compact/full envelopes, exact
  serialized tool-result byte sizing, canonical retention, and a
  duplicate-aggregate normalization that leaves distinct fields
  intact.
- `src/common/passages.ts`: bounded lexical ranking, merged exact
  source slices, Unicode-safe boundaries, and conservative Markdown,
  URL, and citation-token atoms. No alternative extraction engine.
- `src/common/response_metadata.ts`: allowlisted request diagnostics
  associated with adapter result objects through a WeakMap; legacy
  JSON and source entry shapes remain unchanged.
- Tavily search/extract adapters associate root diagnostics without
  adding request fields, including `include_usage`. Public tools
  expose this only in opt-in output. Other providers' metadata is
  preserved.

Public GETs of the official Tavily search/extract Markdown API
references confirmed root `request_id`, numeric `response_time`, and
`usage.credits`. Retrieved hashes matched the P1A hashes below. Search
usage is opt-in upstream by default, so this implementation reports
unknown usage rather than inventing billing. Numeric strings remain
accepted as optional provider diagnostics but are not reported as
measured numbers. Invalid optional metadata does not reject valid
content. This verifies documentation, not live API behavior or spend.

The user explicitly accepted the existing shared trusted-client result
boundary for P1B. No per-client ownership was introduced or claimed.
See [P1B evidence](search-gateway-evolution-p1b.md).

## P1A: Tavily controls

Inspected on 2026-09-06 against local P0 commit
`69e388a5f9a249a9ad48a8efff78059bb9dc3689`. Donor patches and actual
license text were read at these immutable revisions before adaptation:

- [spences10/mcp-omnisearch search controls](https://github.com/spences10/mcp-omnisearch/commit/33a1b9e049f07d27a851ffad9df1ce908952fc42),
  SHA `33a1b9e049f07d27a851ffad9df1ce908952fc42`.
- [spences10/mcp-omnisearch focused extraction](https://github.com/spences10/mcp-omnisearch/commit/2f7774650199ee9c71fcdd078e4a4a4dd6f0eec1),
  SHA `2f7774650199ee9c71fcdd078e4a4a4dd6f0eec1`.

Both licenses are MIT, copyright 2025 Scott Spence. Their retrieved
license bytes match this repository's existing [LICENSE](../LICENSE),
which remains unchanged. The copyright/permission notice is retained.
No Git cherry-pick, history rewriting, package replacement, or other
donor implementation was performed.

### Adapted concepts and paths

- Search enum values and request forwarding were selectively adapted
  from the search donor's `src/common/types.ts`,
  `src/providers/search/tavily/index.ts`,
  `src/server/tools/schemas.ts`, and `src/server/tools/web-search.ts`
  into the local `src/common/types.ts`,
  `src/providers/search/tavily/index.ts`, and
  `src/server/tools/web_search.ts`.
- Extraction chunk/format controls were adapted from the extraction
  donor's `src/server/tools/schemas.ts`,
  `src/server/tools/web-extract.ts`, and
  `src/providers/processing/tavily-extract/index.ts` into the local
  `src/server/tools/web_extract.ts` and
  `src/providers/processing/tavily_extract/index.ts`.
- Existing local query support and 1-5 chunk validation are reused,
  not reimplemented. Optional format is omitted from the request when
  unspecified, preserving the P0 request snapshot instead of importing
  the donor's newly explicit default. Query text is not newly trimmed
  or normalized.
- Local provider-specific guards, conservative conflict rules, safe
  public error messages, additive-schema comparison, and new
  regression tests are independently implemented against the existing
  fork. No donor test bodies or framework were copied.

### Verified authoritative contract, not live API evidence

Read the current official Markdown API references with direct public
GETs. No credentialed provider API call was made:

- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search.md):
  `basic`, `advanced`, `fast`, `ultra-fast` depth; `general`, `news`,
  `finance` topic; relative time ranges; country boosting available
  only with `topic=general`. The public gateway exposes the four
  full-word recency values, not shorthand aliases.
- [Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract.md):
  `chunks_per_source` requires query and accepts integers 1-5;
  `format` accepts `markdown` and `text`, default Markdown.

Search's separate chunk control has a different documented upper bound
and is **not** added in P1A. Do not reuse extraction's limit for
search. Documentation says advanced search uses more provider credits;
this is not a measured charge or request-level USD guarantee.

Combining `time_range` with recognized `before:`/`after:` query
operators is rejected by a conservative gateway policy because
precedence was not established in this scope. This is not a claim that
Tavily itself rejects every such combination. Country/topic rejection
applies when the existing parser would emit a native country filter;
quoted/Boolean operators not mapped to API fields retain their source
query behavior.

Retrieved-byte SHA-256 identifiers:

- Search docs:
  `519714b649b85620e4ceed12d29bb24c47d76cb9a020d81cfa8a7c4987b21a51`.
- Extract docs:
  `b5e2f4679e3e3da83044ae8f30c54215d2bcb0d4aeb9e46715e3b3cf9fe70a62`.
- Search donor patch:
  `943c509f23ce9d1c370ed1018f99c970eeb18079e8e5a251dfb56ec96a9a3b95`.
- Extraction donor patch:
  `7255371e2f9483e1ba7ffe7d0277e2e6ada422e9d996cad311d03691d7d64837`.
- Each donor LICENSE:
  `17f6d4adc5b2db8062009c211a3a10e4f7e750dc819c80101c03b912877ab321`.

The official documentation is mutable; these hashes identify the
inspected response bytes, not a promise of permanent URL immutability.
The local reference evidence is in the P1A validation directory named
in the [phase report](search-gateway-evolution-p1a.md).

### Deliberately not ported

No generic upstream provider registry/schema rewrite, kebab-case path
migration, Kagi support, raw-page search output, safe-search switch,
search chunk count, `auto_parameters`, usage/timing envelopes,
map/crawl, or upstream inline/file result mode was imported. Request
metadata remains for the next P1 contract slice/P2 integration rather
than being duplicated on each search source. The P0 response
snapshots, result-store semantics, HTTP security, retries, and
explicit provider selection remain the compatibility boundary.

Tests: both existing Tavily adapter test files plus
`src/server/tools/tavily_controls.test.ts`,
`src/server/evolution_discovery.test.ts`, and the unchanged P0 legacy
response snapshots. The
[phase report](search-gateway-evolution-p1a.md) records actual
execution and remaining UNVERIFIED gates.
