import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.each([undefined, '', 'none', 'research,media'])(
	'passes group configuration through the clean launcher exactly: %j',
	(groups) => {
		const directory = mkdtempSync(
			join(tmpdir(), 'omnisearch-launcher-'),
		);
		try {
			const bin = join(directory, 'bin');
			mkdirSync(bin);
			const original = readFileSync(
				new URL('../../start-server.sh', import.meta.url),
				'utf8',
			);
			// Redirect only the hard-coded shared credential source in this
			// isolated test copy. Never read the real shared environment.
			const script = original.replaceAll(
				'/home/ubuntu/copilot-api/.env',
				join(directory, 'absent-shared.env'),
			);
			writeFileSync(join(directory, 'start-server.sh'), script);
			writeFileSync(
				join(bin, 'ip'),
				'#!/bin/bash\nset -euo pipefail\nprintf "%s\\n" "1: lo inet 127.0.0.1/8 scope host lo"\n',
				{ mode: 0o700 },
			);
			writeFileSync(
				join(bin, 'node'),
				'#!/bin/bash\nset -euo pipefail\nif [[ -v OMNISEARCH_TOOL_GROUPS ]]; then printf "set:%s\\n" "$OMNISEARCH_TOOL_GROUPS"; else printf "unset\\n"; fi\nif [[ -v PRIVATE_TEST_SECRET ]]; then exit 9; fi\n',
				{ mode: 0o700 },
			);
			const env = {
				PATH: `${bin}:/usr/bin:/bin`,
				HOME: directory,
				BIND_HOST: '127.0.0.1',
				PORT: '8123',
				MCP_API_KEY: 'launcher-fixture-key',
				PRIVATE_TEST_SECRET: 'private-fixture',
				...(groups === undefined
					? {}
					: { OMNISEARCH_TOOL_GROUPS: groups }),
			};
			const run = spawnSync('/bin/bash', ['start-server.sh'], {
				cwd: directory,
				env,
				encoding: 'utf8',
				timeout: 5000,
			});
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout.trimEnd()).toBe(
				groups === undefined ? 'unset' : `set:${groups}`,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
