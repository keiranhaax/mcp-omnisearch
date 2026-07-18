#!/bin/bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${script_dir}"

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

clean_env=(
  "HOME=${HOME}"
  "PATH=${PATH}"
  "USER=${USER:-ubuntu}"
  "LANG=${LANG:-C.UTF-8}"
  "NODE_ENV=production"
)

# Pass only credentials and runtime controls used by Omnisearch. This prevents
# PM2 or an interactive deployment shell from leaking unrelated model secrets
# into the MCP process.
for variable in \
  TAVILY_API_KEY \
  BRAVE_API_KEY \
  BRAVE_ANSWERS_API_KEY \
  GITHUB_API_KEY \
  EXA_API_KEY \
  LINKUP_API_KEY \
  YOU_API_KEY \
  CONTEXT_DEV_API_KEY \
  FIRECRAWL_API_KEY \
  FIRECRAWL_BASE_URL \
  FIRECRAWL_AGENT_URL \
  OMNISEARCH_RESULT_DIR \
  OMNISEARCH_RESULT_TTL_MS \
  OMNISEARCH_RESULT_MAX_BYTES \
  OMNISEARCH_RESULT_STORE_MAX_BYTES
do
  value="${!variable:-}"
  if [[ -n "${value}" ]]; then
    clean_env+=("${variable}=${value}")
  fi
done

exec env -i "${clean_env[@]}" mcp-proxy \
  --host "${BIND_HOST}" \
  --port "${PORT}" \
  --apiKey "${MCP_API_KEY}" \
  --stateless \
  -- node ./dist/index.js
