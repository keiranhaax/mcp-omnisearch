# Architecture decision: serve MCP 2026-07-28 through pinned mcp-proxy (Path A)

- Date: 2026-08-15
- Status: accepted
- Decided per plan Section 7.6 (mandatory decision gate before any
  Path B work)

## Decision

**Path A is accepted.** Production will serve the 2026-07-28 protocol
through a project-local, exactly pinned `mcp-proxy@6.7.3` fronted by a
narrow, reviewed HTTP security guard (`src/server/http_guard.ts`,
entry `src/guard.ts`). Path B (native SDK v2 server migration) is
rejected for this upgrade; see "Why not Path B" below.

## Reliability follow-up (isolated candidate, not deployed)

The original staging observations below are historical, not proof that
the unpatched proxy has no leaks. The later reliability audit
reproduced retained legacy stateless instances. The current candidate
keeps Path A but adds pnpm patches for per-exchange cleanup, explicit
legacy cancellation, validation before modern subscription
acquisition, and cancellable concurrent stdio dispatch. The guard now
authenticates before buffering bodies and bounds connections,
concurrent requests, and global request rate. See `deployment.md` for
candidate controls and verification boundaries. No production
deployment is implied.

## Candidate and integrity metadata

- Runtime toolchain: Node.js v22.23.1, Corepack pnpm 11.9.0
  (repository `packageManager`), Valibot `^1.4.2` (unchanged), tmcp
  `^1.19.4` (unchanged, stdio registration layer retained)
- Candidate: `mcp-proxy@6.7.3` (npm latest as of 2026-08-15)
- Integrity:
  `sha512-kHv74OIgrLpm4gZMCQtDtpxKHIZEgi6itoC2E+WeGm9g6od5/4rd6Cmmp60whsU6Quyb8Yd5UgVNeMJpsba7Kg==`
  (lockfile hash verified byte-identical against the registry metadata
  at install time)
- Declared dependencies: `@modelcontextprotocol/client ^2.0.0`,
  `@modelcontextprotocol/server ^2.0.0`, `pipenet ^1.3.0`
- SDK latest is `2.0.0` (published 2026-07-27); no newer SDK line
  exists to chase
- Install policy note: the repository enforces
  `minimumReleaseAge: 2880` (48 h). 6.7.3 was published
  2026-08-13T17:37Z, so staging installed it under an uncommitted,
  scoped `minimumReleaseAgeExclude: [mcp-proxy]`. The exclusion stays
  uncommitted and can be dropped once the release is older than 48 h
  (2026-08-15T17:37Z) at cutover prep.

## Staging evidence (guard-fronted topology)

Topology under test:

```
client -> http_guard (100.84.79.102:8001)
       -> mcp-proxy@6.7.3 (127.0.0.1:8002, loopback only)
       -> node dist/index.js (stdio)
```

Raw-proxy probing (no guard) identified exactly four gaps; every one
is closed by the guard and re-verified end to end. Final gate battery
through the guard: **26/26 PASS**.

| Gate                                                    | Raw proxy                                         | With guard                        |
| ------------------------------------------------------- | ------------------------------------------------- | --------------------------------- |
| Modern envelope without `MCP-Protocol-Version` (#2589)  | 200 (accepted)                                    | 400, JSON-RPC `-32020`, id echoed |
| Unknown `Host`                                          | 200                                               | 403                               |
| `Host` with userinfo (`user:pass@host`) (#2489 class)   | 500                                               | 403                               |
| Disallowed `Origin`                                     | 200                                               | 403, no CORS headers emitted      |
| CORS preflight                                          | `Access-Control-Allow-Origin: *` with credentials | no `ACAO` header at all           |
| Modern `server/discover` (full envelope + `Mcp-Method`) | 200                                               | 200                               |
| Modern `tools/list`                                     | 200                                               | 200                               |
| Legacy `initialize` 2025-11-25                          | 200 (SSE)                                         | 200 (SSE)                         |
| Legacy stateless `tools/list` / `tools/call`            | 200                                               | 200                               |
| Missing / wrong API key                                 | 401                                               | 401                               |
| Unsupported protocol version                            | 400 `-32022`                                      | 400                               |
| Unknown path / `GET /mcp` / `GET /sse`                  | 404 / 405 / 404                                   | 404 / 405 / 404                   |
| `GET /ping`                                             | 200 `pong`                                        | 200 `pong`                        |
| 5 MB body, declared `Content-Length`                    | 413                                               | 413 (guard rejects pre-dispatch)  |
| 5 MB body, chunked                                      | 413                                               | 413                               |
| Live legacy Brave `web_search`                          | 200                                               | 200                               |
| `result_read` with expired id                           | tool error `isError:true`                         | tool error `isError:true`         |

Streaming: legacy responses arrive as SSE (`event: message`) and pipe
through the guard unbuffered; Caddy already runs `flush_interval -1`
for this route. Client-close cancellation: three requests aborted
mid-flight; the guard destroys the upstream request, the proxy logs a
non-fatal error, and the server keeps serving (verified healthy
afterwards).

Teardown and parallelism: ~4 200 sequential requests against the raw
proxy grew RSS 130 MB to a plateau of ~191 MB (flat over the final
four batches; GC behavior, not the #2607 close-handler leak). A
600-request mixed soak through the guard (300 forwarded + 300
guard-rejected) held guard RSS at a ~74 MB plateau with 0 failures. A
20-way parallel mix of modern and legacy calls returned all 200. One
shared stdio child process served all requests.

Pagination / result store: the `result_read` error path was exercised
through the guard (proper tool error, no transport regression). The
result-store code is transport-independent and untouched by Path A;
staging wrote zero files and the production result directory was
byte-identical (names, sizes, mtimes) before and after. Full
pagination smoke remains scheduled in Task 16 against the release
candidate.

Endpoint compatibility note: the candidate serves streamable HTTP on
`/mcp` only (`--server stream`); the legacy SSE endpoint `/sse`, which
the global 6.4.4 still answers, returns 404 in the new topology. Every
known client — Hermes (`~/.hermes/config.yaml`),
`~/.factory/mcp.json`, and `~/.mcp.json` — already targets `/mcp`, so
no client migration is needed. This retirement is intentional per plan
Section 7.3.2 ("Route only: `GET /ping`, MCP requests on `/mcp`").

## Issue #2589 guard

A guard was required. It lives in this repository:

- `src/server/http_guard.ts` — validators (`check_host`,
  `check_origin`, `classify_body`, `read_bounded_body`) and
  `create_guard_server`. Dependency-free (`node:http` only).
- `src/guard.ts` — runnable entry; owns the public socket, spawns the
  pinned proxy as a child on loopback, forwards signals, exits with
  the child.
- `src/server/http_guard.test.ts` — 28 focused tests covering every
  gate above plus upstream-down (502) and client-abort survival.

The guard enforces, in order: Host allowlist (with userinfo and
malformed rejection), Origin allowlist when the header is present
(never emits CORS headers), route limiting (`POST /mcp`, `GET /ping`
only), a 4 MB pre-dispatch body bound with a 30 s intake deadline, and
the #2589 rule (modern envelope without `MCP-Protocol-Version` →
400/`-32020`). Authentication stays with the proxy (constant-time API
key comparison); the guard never sees the key.

## Host/Origin validation without proxy patching

Complete. The allowlists are exact `host[:port]` matches configured
via `GUARD_ALLOWED_HOSTS` (production: `100.84.79.102:8000`,
`mcp.keiranh.cloud`; staging used `100.84.79.102:8001`). Caddy passes
the client `Host` through unchanged and strips the `/omnisearch`
prefix, so no Caddy changes are needed. No proxy code is patched; the
proxy binds loopback and is unreachable except through the guard.

## Exact diff and operational complexity for Path A

Code (committed on this branch):

- `src/server/http_guard.ts` (new)
- `src/server/http_guard.test.ts` (new)
- `src/guard.ts` (new entry)
- `vite.config.ts` (+1 pack entry line)

Manifest (intentionally uncommitted until cutover prep, per operator
instruction):

- `package.json` / `pnpm-lock.yaml`: exact `mcp-proxy@6.7.3` pin
- `pnpm-workspace.yaml`: scoped `minimumReleaseAgeExclude` (droppable
  once the release matures) and `allowBuilds: { tldjs: false }`

Operations: PM2 keeps managing exactly one foreground process; the
guard spawns the proxy (which spawns the stdio server) and forwards
signals. `start-server.sh` changes only at cutover (Task 17) to exec
`node ./dist/guard.js` with `GUARD_*` env. Rollback is the previous
launcher plus the preserved offline 6.4.4 assets.

## Why not Path B

Path B (native `@modelcontextprotocol/server@2.0.0` migration)
delivers the same externally observable protocol behavior but requires
replacing `tmcp` registration across every tool and resource module, a
new server factory, schema adapter changes, and rewritten handler
tests (plan Tasks 4-14). It would still need the same Host/Origin/
route/#2589 edge checks (the SDK's own open issues are what forced the
guard). Path A reaches the gate with a ~500-line guard plus tests and
zero provider-registration churn, and keeps rollback trivial. Path A
is therefore both the smaller diff and the safer operations story, and
the plan's acceptance criteria for it are met.

## Rollback assets and production integrity

- Global `mcp-proxy` remains `6.4.4` at
  `/usr/lib/node_modules/mcp-proxy`; never modified.
- Offline rollback assets remain at
  `~/backups/mcp-proxy-6.4.4-rollback-20260815T020944Z/`
  (`mcp-proxy-6.4.4.tgz` with verified sha512 integrity, `ROLLBACK.md`
  with a rehearsed restore procedure).
- Production was untouched throughout staging: PM2 `mcp-omnisearch`
  stayed online with 0 restarts on the original pid, the sole
  production listener remained `100.84.79.102:8000`, the Caddyfile was
  unmodified, the production result directory was unchanged, and
  `/ping` answered `pong` after teardown.
