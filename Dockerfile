# Use Node.js 24 Alpine
FROM node:24-alpine

WORKDIR /app

# MCPO uses Python/uv to expose the stdio MCP server over HTTP.
RUN apk add --no-cache python3 py3-pip gettext \
    && pip3 install --break-system-packages uv

# Use the repository-pinned package manager release.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
RUN pnpm run build && pnpm prune --prod

# Keep runtime substitution so credentials are not baked into the image.
RUN printf '%s\n' \
    '{' \
    '  "mcpServers": {' \
    '    "omnisearch": {' \
    '      "command": "node",' \
    '      "args": ["dist/index.js"],' \
    '      "env": {' \
    '        "BRAVE_API_KEY": "${BRAVE_API_KEY}",' \
    '        "BRAVE_ANSWERS_API_KEY": "${BRAVE_ANSWERS_API_KEY}",' \
    '        "TAVILY_API_KEY": "${TAVILY_API_KEY}",' \
    '        "GITHUB_API_KEY": "${GITHUB_API_KEY}",' \
    '        "EXA_API_KEY": "${EXA_API_KEY}",' \
    '        "LINKUP_API_KEY": "${LINKUP_API_KEY}",' \
    '        "YOU_API_KEY": "${YOU_API_KEY}",' \
    '        "CONTEXT_DEV_API_KEY": "${CONTEXT_DEV_API_KEY}",' \
    '        "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}",' \
    '        "FIRECRAWL_BASE_URL": "${FIRECRAWL_BASE_URL}",' \
    '        "FIRECRAWL_AGENT_URL": "${FIRECRAWL_AGENT_URL}"' \
    '      }' \
    '    }' \
    '  }' \
    '}' > /app/mcpo-config.json

RUN python3 -m json.tool /app/mcpo-config.json > /dev/null

RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'envsubst < /app/mcpo-config.json > /tmp/mcpo-config-final.json' \
    'exec uv tool run mcpo --port ${PORT:-8000} --config /tmp/mcpo-config-final.json' \
    > /app/start.sh \
    && chmod +x /app/start.sh \
    && chown -R node:node /app

USER node
EXPOSE 8000
ENV NODE_ENV=production

CMD ["/app/start.sh"]
