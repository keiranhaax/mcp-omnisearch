import { describe, expect, it } from 'vitest';
import { canonical_url as script_canonical_url } from '../../scripts/eval/scoring.mjs';
import { canonical_url } from './canonical_url.js';

const cases: Array<[unknown, string | undefined]> = [
	['https://Example.COM/Path/', 'https://example.com/Path'],
	['https://example.com:443/a?b=1#frag', 'https://example.com/a?b=1'],
	['http://example.com:80/', 'http://example.com'],
	['http://example.com:8080/x/', 'http://example.com:8080/x'],
	[
		'https://example.com/p?utm_source=a&keep=1&utm_medium=b&fbclid=x&gclid=y',
		'https://example.com/p?keep=1',
	],
	['https://example.com/p?UTM_CAMPAIGN=x', 'https://example.com/p'],
	[
		'https://example.com/p?ref_src=twsrc&id=2',
		'https://example.com/p?id=2',
	],
	['https://example.com/a//b///', 'https://example.com/a//b'],
	['  https://example.com/x  ', 'https://example.com/x'],
	['https://example.com/x?b=2&a=1', 'https://example.com/x?b=2&a=1'],
	['https://user:pw@example.com/x', 'https://example.com/x'],
	['ftp://example.com/x', undefined],
	['javascript:alert(1)', undefined],
	['/relative', undefined],
	['', undefined],
	[undefined, undefined],
	[7, undefined],
];

describe('canonical_url', () => {
	it.each(cases)('canonicalises %j', (raw, expected) => {
		expect(canonical_url(raw)).toBe(expected);
	});

	it("agrees with the scorer's copy on every case", () => {
		for (const [raw] of cases)
			expect(script_canonical_url(raw)).toBe(canonical_url(raw));
	});
});
