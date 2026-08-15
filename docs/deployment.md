# Production deployment: MCP 2026-07-28 via pinned proxy (Path A)

This fork runs in production on `vnic-keiran` behind a narrow HTTP
security guard. This document is the reproducible runbook for that
topology. The architecture decision and full staging evidence live in
`docs/architecture-decision-mcp-2026-07-28.md`.

## Versions

| Component                                 | Version  |
| ----------------------------------------- | -------- |
| Node.js                                   | v22.23.1 |
| pnpm (Corepack, repo `packageManager`)    | 11.9.0   |
| mcp-proxy (project-local, exact pin)      | 6.7.3    |
| `@modelcontextprotocol/*` (via mcp-proxy) | ^2.0.0   |
| Valibot                                   | ^1.4.2   |
| tmcp (stdio registration layer)           | ^1.19.4  |

The global `mcp-proxy@6.4.4` installation is deliberately left
untouched as the rollback runtime; production no longer executes it.

## Topology

```
client
  -> http_guard (100.84.79.102:8000)      # src/guard.ts, dist/guard.js
  -> mcp-proxy@6.7.3 (127.0.0.1:8002)     # loopback only, spawned child
  -> node dist/index.js (stdio)           # tmcp registration, unchanged
```

PM2 manages exactly one foreground process (`start-server.sh` ->
`node ./dist/guard.js`); the guard spawns the proxy, which spawns the
stdio server, and signals propagate down the chain.

## Protocol support

- Modern `2026-07-28`: full envelope validation
  (`io.modelcontextprotocol/protocolVersion` +
  `io.modelcontextprotocol/clientCapabilities` in `params._meta`),
  `MCP-Protocol-Version` and `Mcp-Method` headers required.
- Legacy `2025-11-25`: stateless streamable HTTP on `/mcp`, no session
  headers, no envelope required. This is what Hermes and the other
  local clients speak.
- `/sse` is retired (404). All known clients already use `/mcp`.

## Edge policy (enforced by the guard)

- `Host` allowlist: `100.84.79.102:8000` (direct Tailscale) and
  `mcp.keiranh.cloud` (via Caddy). Anything else: 403. Userinfo or
  malformed Host: 403 (never 500).
- `Origin`: validated against the same allowlist when present; absent
  Origin (non-browser clients) is allowed. No CORS headers are ever
  emitted.
- Routes: `POST /mcp` and `GET /ping` only. Everything else 404/405.
- Body: 4 MB pre-dispatch bound (declared and chunked), 30 s intake
  deadline; the proxy enforces the same bound again downstream.
- `#2589` guard: a modern envelope without `MCP-Protocol-Version` gets
  400 with JSON-RPC `-32020`; legacy no-envelope requests pass.
- Authentication stays with the proxy (constant-time `X-API-Key`
  comparison). The guard never inspects the key at request time; it
  hands `MCP_API_KEY` to the spawned proxy as `MCP_PROXY_API_KEY` in
  the child environment, keeping it out of `/proc/*/cmdline`. Caddy
  translates `Authorization: Bearer` to `X-API-Key` and redacts both
  from logs.

## Ingress paths

- Direct Tailscale: `http://100.84.79.102:8000/mcp`
- Public: `https://mcp.keiranh.cloud/omnisearch/mcp` (Caddy
  `handle_path /omnisearch/*`, 4 MB `request_body`, Bearer
  translation, `flush_interval -1` for SSE)

## Configuration

`start-server.sh` sources `.env` in place and passes an explicit
allowlist of variables through `env -i`. Guard settings:

| Variable              | Default                              | Purpose                        |
| --------------------- | ------------------------------------ | ------------------------------ |
| `GUARD_LISTEN_HOST`   | `$BIND_HOST`                         | Public socket bind             |
| `GUARD_LISTEN_PORT`   | `$PORT`                              | Public socket port             |
| `GUARD_ALLOWED_HOSTS` | `$BIND_HOST:$PORT,mcp.keiranh.cloud` | Host/Origin allowlist          |
| `GUARD_UPSTREAM_PORT` | `8002`                               | Loopback proxy port            |
| `GUARD_PUBLIC_HOSTS`  | `mcp.keiranh.cloud`                  | TLS hostname(s) Caddy forwards |

The launcher fails closed on a wildcard `BIND_HOST` (the guard needs
an explicit address to build the allowlist).

## Verification commands

Staging (worktree, port 8001):

```bash
/home/ubuntu/worktrees/mcp-omnisearch-mcp-2026/staging/run-staging.sh
```

Direct production probes (never print the key):

```bash
key=$(grep -E '^MCP_API_KEY=' /opt/mcp-omnisearch/.env | head -1 | cut -d= -f2- | tr -d "\"'")
curl -sS http://100.84.79.102:8000/ping
curl -sS -X POST http://100.84.79.102:8000/mcp \
  -H "X-API-Key: $key" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"elicitation":{},"roots":{},"sampling":{}}}}}'
```

Public path and Hermes:

```bash
curl -sS https://mcp.keiranh.cloud/omnisearch/ping
hermes mcp test omnisearch
```

## Staging procedure and result isolation

Staging uses the same launcher with explicit overrides (`PORT=8001`,
`GUARD_ALLOWED_HOSTS=100.84.79.102:8001`,
`OMNISEARCH_RESULT_DIR=~/.cache/mcp-omnisearch/staging-mcp-2026` mode
0700). Result offloads (>80 000 serialized chars) land in the staging
directory only; verify the production result directory by metadata
comparison (names, sizes, mtimes) before and after.

## Rollback

The release commit is `21dd09d` on
`feature/omnisearch-mcp-2026-07-28`; the pre-upgrade baseline is
`e33186d` (`keiran/production-fork-baseline-20260717`).

```bash
cd /opt/mcp-omnisearch
git checkout keiran/production-fork-baseline-20260717
corepack pnpm install --frozen-lockfile
corepack pnpm run build
pm2 restart mcp-omnisearch
```

The baseline launcher uses the global `mcp-proxy@6.4.4`, which was
never modified. If the global binary itself is ever damaged, offline
restore material lives in
`~/backups/mcp-proxy-6.4.4-rollback-20260815T020944Z/` (tarball with
verified sha512 integrity plus `ROLLBACK.md` with a rehearsed
restore).

## Fork metadata policy

This is a private fork deployed from git, not published to npm or the
MCP registry. `package.json` stays at `0.0.24` and `server.json` is
unchanged; version bumps and registry metadata only matter if the fork
is ever published upstream again.
