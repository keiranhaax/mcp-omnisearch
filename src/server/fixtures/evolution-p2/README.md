# P2 built lifecycle and sanitization smoke

`smoke.mjs` launches the actual built stdio server with synthetic
credentials and a temporary result directory. Only upstream fetch is
mocked; socket networking is denied in the server process. It
verifies:

- Failed Tavily Research/Firecrawl Agent observations preserve partial
  evidence and reconstruct it exactly through `result_read`.
- Agent start and acknowledged cancellation reuse one job ID with
  exactly one creation POST.
- Exa search and Firecrawl scrape compact results fit 2048 serialized
  MCP tool-result UTF-8 bytes, excluding JSON-RPC framing.
- Provider-control canaries are absent inline, after
  retention/readback, and in captured stderr. Real source text,
  code/math citations, URL parameters, Unicode, and structured `token`
  fields remain intact.

Exactly six synthetic provider fetches are required; unexpected calls
fail. No live provider, billing, entitlement, or deployment claim
follows from this smoke. The script cleans up only its own child and
temporary home. Build first with the prepared dependencies:

```bash
./node_modules/.bin/vp pack
node src/server/fixtures/evolution-p2/smoke.mjs
```

For the credential-isolated full gate and historical fixture
disposition, see the
[P2 report](../../../../docs/search-gateway-evolution-p2.md). Unit and
public-dispatch lifecycle tests additionally cover unknown states,
malformed responses, partial-to-failed transitions, unconfirmed
cancellation, local wait interruption, storage failure, and complete
async envelope boundaries. No fixture-refresh mode is provided.
