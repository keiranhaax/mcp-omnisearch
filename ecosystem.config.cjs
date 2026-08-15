module.exports = {
	apps: [
		{
			name: 'mcp-omnisearch',
			script: '/opt/mcp-omnisearch/start-server.sh',
			cwd: '/opt/mcp-omnisearch',
			interpreter: '/bin/bash',
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
			},
			autorestart: true,
			min_uptime: 10000,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 10000,
			max_memory_restart: '512M',
			error_file: '/home/ubuntu/.pm2/logs/mcp-omnisearch-error.log',
			out_file: '/home/ubuntu/.pm2/logs/mcp-omnisearch-out.log',
			log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
		},
	],
};
