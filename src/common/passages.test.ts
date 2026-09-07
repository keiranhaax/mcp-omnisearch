import { describe, expect, it } from 'vitest';
import { select_passages } from './passages.js';

describe('select_passages', () => {
	it.each([
		'https://example.test/report?edition=2&language=中文',
		'[citation-12345]',
		'[evidence](https://example.test/report?edition=2)',
	])(
		'never cuts a URL or citation token at a selection boundary: %s',
		(token) => {
			const text =
				'Leading '.repeat(5) + token + ' trailing '.repeat(50);
			for (const query of [
				undefined,
				'trailing',
				'evidence',
				'edition',
			]) {
				for (const budget of [45, 64, 90, 120]) {
					for (const passage of select_passages(text, query, budget)
						.passages) {
						const start = text.indexOf(token),
							end = start + token.length;
						expect(passage.start > start && passage.start < end).toBe(
							false,
						);
						expect(passage.end > start && passage.end < end).toBe(
							false,
						);
						expect(passage.text).toBe(
							text.slice(passage.start, passage.end),
						);
					}
				}
			}
		},
	);
	it('keeps a long unbroken query hit intact when it fits the selection budget', () => {
		const query = 'identifier'.repeat(60);
		const text = 'x'.repeat(500) + query + 'x'.repeat(500);
		const result = select_passages(text, query, 700);
		expect(result.passages).toHaveLength(1);
		expect(result.passages[0].text).toContain(query);
		expect(result.passages[0].text.length).toBeLessThanOrEqual(700);
	});

	it('advances past a surrogate pair straddling a hit-sampling boundary', () => {
		const text = 'x'.repeat(199) + '🙂'.repeat(500);
		const result = select_passages(text, '🙂', 60);
		expect(result.method).toBe('query');
		expect(result.passages[0].text).toContain('🙂');
		expect(result.passages[0].text).not.toMatch(/[\uD800-\uDFFF]/u);
	});

	// These invariants characterize the already-green selection paths.
	it('retains exact UTF-16 slices and honest omission across mixed-source budgets', () => {
		const texts = [
			'',
			' \n\n',
			'🙂a🙂b🙂',
			'needle\n\nneedle\n',
			'  # needle heading\nparagraph 🙂搜索\n\n',
			'title needle\nsecond line\n---\nbody',
			'intro\n````ts\nneedle\n```\nnot closed yet\n````\nend',
			'intro\n~~~\nneedle\n```\nstill inside\n',
			'needle\n\n' + '🙂'.repeat(300) + '\n\nneedle\n',
			('x'.repeat(300) + '\n## needle\n').repeat(20),
		];
		for (const text of texts) {
			for (const query of [
				undefined,
				'  \n',
				'needle',
				'搜索 🙂',
				'[.*+?]',
			]) {
				for (const budget of [
					0, 1, 2, 3, 10, 31, 100, 399, 400, 800, 4000,
				]) {
					const result = select_passages(text, query, budget);
					let previous_end = -1;
					let used = 0;
					for (const passage of result.passages) {
						expect(passage.start).toBeGreaterThan(previous_end);
						expect(passage.end).toBeGreaterThan(passage.start);
						expect(passage.end).toBeLessThanOrEqual(text.length);
						expect(passage.text).toBe(
							text.slice(passage.start, passage.end),
						);
						expect(passage.text).not.toMatch(/[\uD800-\uDFFF]/u);
						previous_end = passage.end;
						used += passage.text.length;
					}
					expect(used).toBeLessThanOrEqual(budget);
					expect(result.omitted).toBe(
						result.passages
							.map((passage) => passage.text)
							.join('') !== text,
					);
				}
			}
		}
	});

	it('labels empty and whitespace queries as leading and empty text as fully reproduced', () => {
		expect(select_passages('')).toEqual({
			passages: [],
			method: 'leading',
			omitted: false,
		});
		expect(select_passages('', 'needle')).toEqual({
			passages: [],
			method: 'no_hit',
			omitted: false,
		});
		expect(select_passages('a\n\nb\n', ' \n\t')).toEqual({
			passages: [
				{ start: 0, end: 'a\n\nb\n'.length, text: 'a\n\nb\n' },
			],
			method: 'leading',
			omitted: false,
		});
		expect(select_passages('needle', 'needle', 0)).toEqual({
			passages: [],
			method: 'query',
			omitted: true,
		});
		expect(select_passages('x'.repeat(5000)).passages[0].end).toBe(
			4000,
		);
	});

	it.each(['```', '~~~~'])(
		'preserves an unclosed fence through EOF: %s',
		(marker) => {
			const fence = marker + '\nneedle\n' + 'x'.repeat(100);
			const text = 'intro\n' + fence;
			expect(select_passages(text, 'needle', 20).passages).toEqual(
				[],
			);
			expect(
				select_passages(text, 'needle', 200).passages[0].text,
			).toContain(fence);
		},
	);

	it('handles a large heading-rich input without nested whole-document scans', () => {
		const text = '## needle heading\nbody\n\n'.repeat(12000);
		const query = 'needle ' + 'irrelevant '.repeat(100000);
		const result = select_passages(text, query, 4000);
		expect(result.method).toBe('query');
		expect(result.passages[0].text).toContain('needle');
		expect(
			result.passages.reduce(
				(sum, passage) => sum + passage.text.length,
				0,
			),
		).toBeLessThanOrEqual(4000);
	});

	it('matches a query whose Unicode lowercase form changes length without changing source offsets', () => {
		const text = 'x'.repeat(500) + 'İstanbul' + 'x'.repeat(500);
		const result = select_passages(text, 'İstanbul', 30);
		expect(result.method).toBe('query');
		expect(result.passages[0].text).toContain('İstanbul');
	});

	it.each(['搜索', '🙂', '🇬🇧', 'foo_bar', 'ÉCOLE'])(
		'selects Unicode or code query tokens with exact offsets: %s',
		(query) => {
			const text = 'İ'.repeat(300) + query + '界'.repeat(300);
			const result = select_passages(text, query, 40);
			expect(result.method).toBe('query');
			expect(result.passages[0].text).toContain(query);
			for (const passage of result.passages) {
				expect(passage.text).toBe(
					text.slice(passage.start, passage.end),
				);
				expect(passage.text).not.toMatch(/[\uD800-\uDFFF]/u);
			}
		},
	);

	it('keeps the more relevant window when distinct terms hit the same bucket', () => {
		const text =
			'alpha' + 'x'.repeat(100) + 'alpha beta' + 'x'.repeat(100);
		const result = select_passages(text, 'alpha beta', 40);
		expect(result.passages[0].text).toContain('alpha beta');
	});

	it('bounds the number of disjoint output passages even with an enormous budget', () => {
		const text = ('needle' + 'x'.repeat(1000)).repeat(2000);
		const result = select_passages(
			text,
			'needle',
			Number.MAX_SAFE_INTEGER,
		);
		expect(result.method).toBe('query');
		expect(result.passages.length).toBeLessThanOrEqual(128);
		expect(result.passages.length).toBeGreaterThan(1);
		expect(result.omitted).toBe(true);
	});

	it('can select a fitting whole fence even when surrounding context would exceed budget', () => {
		const fence =
			'```\n' +
			'x'.repeat(10) +
			'needle' +
			'x'.repeat(190) +
			'\n```\n';
		const text = 'x'.repeat(300) + '\n' + fence + 'x'.repeat(300);
		const result = select_passages(text, 'needle', fence.length);
		expect(result.passages).toEqual([
			{ start: 301, end: 301 + fence.length, text: fence },
		]);
	});

	it('does not let an omitted code hit hide a later usable hit in the same context bucket', () => {
		const text =
			'```\nneedle ' + 'x'.repeat(100) + '\n```\nneedle outside';
		const result = select_passages(text, 'needle', 30);
		expect(result.passages).toHaveLength(1);
		expect(result.passages[0].text).toContain('needle outside');
		expect(result.passages[0].text).not.toContain('```');
	});

	it('bounds pathological query work to a 4096-unit prefix and 32 distinct tokens', () => {
		const text = 'x'.repeat(500) + 'needle';
		expect(
			select_passages(text, ' '.repeat(4096) + 'needle', 50),
		).toEqual(select_passages(text, undefined, 50));
		const prefix = Array.from(
			{ length: 32 },
			(_, i) => `absent${i}`,
		).join(' ');
		expect(select_passages(text, prefix + ' needle', 50).method).toBe(
			'no_hit',
		);
	});

	it('preserves Setext heading text and underline as one atom', () => {
		const text =
			'An important needle heading\n===========================\nbody';
		expect(select_passages(text, undefined, 20).passages).toEqual([]);
		expect(select_passages(text, 'needle', 20).passages).toEqual([]);
		expect(
			select_passages(text, 'needle', 100).passages[0].text,
		).toBe(text);
	});

	it.each(['```ts', '~~~python'])(
		'keeps fenced code atomic, omitting oversized fences: %s',
		(opening) => {
			const fence =
				opening +
				'\n' +
				'let needle = true;\n'.repeat(20) +
				opening.slice(0, 3) +
				'\n';
			const text = 'intro\n' + fence + 'outro';
			expect(select_passages(text, 'needle', 60).passages).toEqual(
				[],
			);
			expect(select_passages(text, undefined, 60).passages).toEqual([
				{ start: 0, end: 6, text: 'intro\n' },
			]);
			expect(
				select_passages(text, 'needle', 600).passages[0].text,
			).toContain(fence);
		},
	);

	it.each([
		'# A long heading with needle inside',
		'## A long heading with needle inside',
	])('does not slice an ATX heading: %s', (heading) => {
		const text = heading + '\nBody text';
		expect(select_passages(text, undefined, 12).passages).toEqual([]);
		expect(select_passages(text, 'needle', 12).passages).toEqual([]);
		expect(
			select_passages(text, 'needle', 100).passages[0].text,
		).toContain(heading);
	});

	it('merges overlapping contexts without charging or reproducing characters twice', () => {
		const text =
			'x'.repeat(300) +
			'needle' +
			'x'.repeat(200) +
			'needle' +
			'x'.repeat(300);
		const result = select_passages(text, 'needle', 800);
		expect(result.passages).toHaveLength(1);
		expect(result.passages[0].text.match(/needle/g)).toHaveLength(2);
		const { start, end } = result.passages[0];
		expect(result.passages[0].text).toBe(text.slice(start, end));
	});

	it('presents disjoint relevant passages in source order rather than relevance order', () => {
		const text =
			'x'.repeat(500) +
			'alpha' +
			'x'.repeat(1000) +
			'alpha beta' +
			'x'.repeat(500);
		const result = select_passages(text, 'alpha beta', 800);
		expect(result.passages).toHaveLength(2);
		expect(result.passages[0].text).toContain('alpha');
		expect(result.passages[1].text).toContain('alpha beta');
		expect(result.passages[0].end).toBeLessThan(
			result.passages[1].start,
		);
		expect(
			result.passages.reduce(
				(sum, passage) => sum + passage.text.length,
				0,
			),
		).toBeLessThanOrEqual(800);
	});

	it('ranks distinct query tokens above repetition, breaking equal scores by source position', () => {
		const text =
			'alpha '.repeat(80) +
			'x'.repeat(600) +
			'alpha and BETA' +
			'x'.repeat(600) +
			'alpha and BETA';
		const result = select_passages(text, 'beta alpha', 80);
		expect(result.method).toBe('query');
		expect(result.passages).toHaveLength(1);
		expect(result.passages[0].text).toContain('alpha and BETA');
		expect(result.passages[0].start).toBeLessThan(
			text.lastIndexOf('alpha and BETA'),
		);
		expect(result).toEqual(
			select_passages(text, 'alpha alpha beta', 80),
		);
	});

	it('selects bounded context around a case-insensitive hit on a long line', () => {
		const text = 'x'.repeat(2000) + ' NEEDLE ' + 'y'.repeat(2000);
		const result = select_passages(text, 'needle', 50);
		expect(result.method).toBe('query');
		expect(result.passages).toHaveLength(1);
		const passage = result.passages[0];
		expect(passage.text).toContain('NEEDLE');
		expect(passage.start).toBeGreaterThan(1900);
		expect(passage.text).toBe(text.slice(passage.start, passage.end));
		expect(passage.text.length).toBeLessThanOrEqual(50);
		expect(result.omitted).toBe(true);
	});

	it('labels absent query matches instead of pretending the preview is relevant', () => {
		expect(select_passages('plain content', 'missing', 5)).toEqual({
			passages: [{ start: 0, end: 5, text: 'plain' }],
			method: 'no_hit',
			omitted: true,
		});
	});

	it('does not cut a UTF-16 surrogate pair at the preview boundary', () => {
		expect(select_passages('a🙂b', undefined, 2).passages).toEqual([
			{ start: 0, end: 1, text: 'a' },
		]);
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects a non-integer or negative budget: %s',
		(limit) => {
			expect(() => select_passages('abc', undefined, limit)).toThrow(
				RangeError,
			);
		},
	);

	it('labels a bounded leading preview without changing source offsets', () => {
		expect(select_passages('first\n\nsecond', undefined, 7)).toEqual({
			passages: [{ start: 0, end: 7, text: 'first\n\n' }],
			method: 'leading',
			omitted: true,
		});
	});
});
