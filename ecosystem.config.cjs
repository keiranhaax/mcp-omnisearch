module.exports = {
  apps: [{
    name: "mcp-omnisearch",
    script: "/opt/mcp-omnisearch/start-server.sh",
    cwd: "/opt/mcp-omnisearch",
    interpreter: "/bin/bash",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME
    },
    error_file: "/home/ubuntu/.pm2/logs/mcp-omnisearch-error.log",
    out_file: "/home/ubuntu/.pm2/logs/mcp-omnisearch-out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z"
  }]
};
