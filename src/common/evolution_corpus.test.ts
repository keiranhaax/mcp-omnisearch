import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = new URL(
	'./fixtures/evolution-html/',
	import.meta.url,
);
const manifest = JSON.parse(
	readFileSync(new URL('manifest.json', directory), 'utf8'),
) as {
	license: string;
	network: string;
	cases: Array<{
		id: string;
		file: string;
		url: string;
		query: string;
		disposition: string;
		anchors: string[];
		sha256: string;
	}>;
};

describe('P0 fixed local HTML corpus, not parser verification', () => {
	it('accounts for every local HTML file and uniquely identified query', () => {
		expect(manifest.license).toBe('MIT');
		expect(manifest.network).toBe('forbidden');
		expect(new Set(manifest.cases.map(({ id }) => id)).size).toBe(
			manifest.cases.length,
		);
		const files = readdirSync(fileURLToPath(directory))
			.filter((file) => file.endsWith('.html.fixture'))
			.sort();
		expect(
			[...new Set(manifest.cases.map(({ file }) => file))].sort(),
		).toEqual(files);
		expect(manifest.cases.some(({ query }) => query === '')).toBe(
			true,
		);
		expect(
			manifest.cases.some(
				({ disposition }) => disposition === 'no-hit-preview',
			),
		).toBe(true);
	});

	it.each(manifest.cases)(
		'locks original source and evidence anchors for $id',
		(entry) => {
			expect(entry.file).toMatch(/^[a-z-]+\.html\.fixture$/);
			const source = readFileSync(new URL(entry.file, directory));
			expect(createHash('sha256').update(source).digest('hex')).toBe(
				entry.sha256,
			);
			const url = new URL(entry.url);
			expect(url.protocol).toBe('https:');
			expect(url.hostname.endsWith('.test')).toBe(true);
			for (const anchor of entry.anchors)
				expect(source.toString('utf8')).toContain(anchor);
			expect(typeof entry.query).toBe('string');
		},
	);
});
