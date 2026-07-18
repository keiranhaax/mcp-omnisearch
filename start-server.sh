#!/bin/bash
set -euo pipefail
umask 077

cd /opt/mcp-omnisearch

# Read only GitHub credentials from the shared copilot-api environment. Do not
# inherit unrelated secrets into the Omnisearch process.
copilot_github_api_key=''
if [[ -f /home/ubuntu/copilot-api/.env ]]; then
	copilot_github_api_key="$(
		set +u
		set -a
		source /home/ubuntu/copilot-api/.env
		printf '%s' "${GH_TOKEN:-${GITHUB_TOKEN:-${GITHUB_API_KEY:-}}}"
	)"
fi

set -a
if [[ -f .env ]]; then
	source .env
fi
set +a

# Keep GitHub auth centralized so omnisearch follows the token used by
# copilot-api after rotation without inheriting its full environment.
export GITHUB_API_KEY="${copilot_github_api_key:-${GH_TOKEN:-${GITHUB_TOKEN:-${GITHUB_API_KEY:-}}}}"

# Upstream expects BRAVE_API_KEY; local .env uses BRAVE_SEARCH_API_KEY
export BRAVE_API_KEY="${BRAVE_API_KEY:-${BRAVE_SEARCH_API_KEY:-}}"

if [[ -f ./brave-key-rotation.sh ]]; then
	source ./brave-key-rotation.sh
fi

: "${MCP_API_KEY:?MCP_API_KEY must be set}"
: "${PORT:=8000}"
: "${BIND_HOST:=0.0.0.0}"

# PM2 can start before Tailscale has restored its interface during boot. Wait
# briefly for an explicitly configured interface address instead of falling
# back to every network interface.
if [[ "${BIND_HOST}" != "0.0.0.0" && "${BIND_HOST}" != "::" ]]; then
	bind_ready=false
	for _ in {1..30}; do
		if ip -o address show | grep -Fq " ${BIND_HOST}/"; then
			bind_ready=true
			break
		fi
		sleep 2
	done
	if [[ "${bind_ready}" != true ]]; then
		printf 'BIND_HOST is not assigned after 60 seconds: %s\n' "${BIND_HOST}" >&2
		exit 1
	fi
fi

export MCP_API_KEY
exec mcp-proxy \
  --host "${BIND_HOST}" \
  --port "${PORT}" \
  --apiKey "${MCP_API_KEY}" \
  --stateless \
  -- node ./dist/index.js
