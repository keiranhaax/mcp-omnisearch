#!/bin/bash
set -euo pipefail

cd /opt/mcp-omnisearch

set -a
if [[ -f /home/ubuntu/copilot-api/.env ]]; then
	source /home/ubuntu/copilot-api/.env
fi

if [[ -f .env ]]; then
	source .env
fi
set +a

# Keep GitHub auth centralized so omnisearch follows the token used by
# copilot-api after rotation.
export GITHUB_API_KEY="${GH_TOKEN:-${GITHUB_TOKEN:-${GITHUB_API_KEY:-}}}"

# Upstream expects BRAVE_API_KEY; local .env uses BRAVE_SEARCH_API_KEY
export BRAVE_API_KEY="${BRAVE_API_KEY:-${BRAVE_SEARCH_API_KEY:-}}"

if [[ -f ./brave-key-rotation.sh ]]; then
	source ./brave-key-rotation.sh
fi

: "${MCP_API_KEY:?MCP_API_KEY must be set}"
: "${PORT:=8000}"

export MCP_API_KEY
exec mcp-proxy \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --apiKey "${MCP_API_KEY}" \
  --stateless \
  -- node ./dist/index.js
