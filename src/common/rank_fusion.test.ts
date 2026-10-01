import { describe, expect, it } from 'vitest';
import { fuse_results, RRF_K } from './rank_fusion.js';
import type { SearchResult } from './types.js';

const hit = (
	provider: string,
	url: string,
	extra: Partial<SearchResult> = {},
): SearchResult => ({
	title: `${provider} ${url}`,
	url,
	snippet: `${provider} snippet`,
	source_provider: provider,
	...extra,
});
const rrf = (...ranks: number[]) =>
	Number(
		ranks
			.reduce((sum, rank) => sum + 1 / (RRF_K + rank), 0)
			.toFixed(6),
	);

describe('reciprocal rank fusion', () => {
	it('sums 1/(k+rank) across providers after canonicalising URLs', () => {
		const fused = fuse_results(
			[
				{
					provider: 'a',
					results: [
						hit('a', 'https://x.test/one'),
						hit('a', 'https://x.test/two?utm_source=a'),
						hit('a', 'https://x.test/three'),
					],
				},
				{
					provider: 'b',
					results: [
						hit('b', 'https://X.test/two/#frag'),
						hit('b', 'https://x.test/four'),
						hit('b', 'https://x.test/one'),
					],
				},
			],
			{ limit: 10 },
		);
		expect(fused).toMatchObject({
			candidates: 4,
			duplicates_removed: 0,
			unaddressed: 0,
		});
		expect(
			fused.results.map(
				({ canonical_url, score, source_providers, ranks }) => ({
					canonical_url,
					score,
					source_providers,
					ranks,
				}),
			),
		).toEqual([
			{
				canonical_url: 'https://x.test/two',
				score: rrf(2, 1),
				source_providers: ['a', 'b'],
				ranks: { a: 2, b: 1 },
			},
			{
				canonical_url: 'https://x.test/one',
				score: rrf(1, 3),
				source_providers: ['a', 'b'],
				ranks: { a: 1, b: 3 },
			},
			{
				canonical_url: 'https://x.test/four',
				score: rrf(2),
				source_providers: ['b'],
				ranks: { b: 2 },
			},
			{
				canonical_url: 'https://x.test/three',
				score: rrf(3),
				source_providers: ['a'],
				ranks: { a: 3 },
			},
		]);
		// The first provider in caller order supplies the presentation.
		expect(fused.results[0]).toMatchObject({
			title: 'a https://x.test/two?utm_source=a',
			url: 'https://x.test/two?utm_source=a',
			snippet: 'a snippet',
			source_provider: 'a',
		});
		expect(fused.results[2].source_provider).toBe('b');
	});

	it('drops repeats within one provider, skips unaddressable results and applies the limit', () => {
		const fused = fuse_results(
			[
				{
					provider: 'a',
					results: [
						hit('a', 'https://x.test/one'),
						hit('a', 'https://x.test/one/'),
						hit('a', '', { title: 'Untitled', snippet: 'no url' }),
						hit('a', 'https://x.test/two'),
					],
				},
				{
					provider: 'b',
					results: [
						hit('b', 'not a url'),
						hit('b', 'https://x.test/three'),
					],
				},
			],
			{ limit: 2 },
		);
		expect(fused).toMatchObject({
			candidates: 3,
			duplicates_removed: 1,
			unaddressed: 2,
		});
		// `one` and `three` tie at rank 1; the first seen wins, and the
		// limit leaves `two` out.
		expect(fused.results.map((item) => item.canonical_url)).toEqual([
			'https://x.test/one',
			'https://x.test/three',
		]);
		// A skipped result does not consume a rank.
		expect(fused.results[1].ranks).toEqual({ b: 1 });
		expect(
			fuse_results(
				[
					{
						provider: 'a',
						results: [
							hit('a', ''),
							hit('a', 'https://x.test/one'),
							hit('a', 'https://x.test/two'),
						],
					},
				],
				{ limit: 10 },
			).results.map((item) => item.ranks),
		).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it('breaks score ties by provider count, then best rank, then first seen', () => {
		const fused = fuse_results(
			[
				{
					provider: 'a',
					results: [
						hit('a', 'https://x.test/p'),
						hit('a', 'https://x.test/q'),
					],
				},
				{
					provider: 'b',
					results: [
						hit('b', 'https://x.test/r'),
						hit('b', 'https://x.test/s'),
					],
				},
			],
			{ limit: 10, k: 0 },
		);
		expect(fused.results.map((item) => item.canonical_url)).toEqual([
			'https://x.test/p',
			'https://x.test/r',
			'https://x.test/q',
			'https://x.test/s',
		]);
		expect(fused.results[0].score).toBe(1);
	});

	it('fills an empty title or snippet from a later provider and keeps the first metadata', () => {
		const fused = fuse_results(
			[
				{
					provider: 'a',
					results: [
						hit('a', 'https://x.test/one', {
							title: '',
							snippet: ' ',
							metadata: { from: 'a' },
						}),
					],
				},
				{
					provider: 'b',
					results: [
						hit('b', 'https://x.test/one', {
							metadata: { from: 'b' },
						}),
					],
				},
			],
			{ limit: 1 },
		);
		expect(fused.results[0]).toMatchObject({
			title: 'b https://x.test/one',
			snippet: 'b snippet',
			metadata: { from: 'a' },
			source_provider: 'a',
		});
	});
});
