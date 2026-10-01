import { canonical_url } from './canonical_url.js';
import type { SearchResult } from './types.js';

/**
 * Reciprocal rank fusion of several providers' ranked lists. Each
 * result scores the sum of 1 / (k + rank) over the providers that
 * returned it, after URL canonicalisation collapses duplicates. The
 * first provider in the caller's order supplies the title, snippet and
 * metadata of a merged result; every contributing provider and its
 * rank are kept.
 */

export const RRF_K = 60;

export interface FusedResult extends SearchResult {
	canonical_url: string;
	/** Providers that returned this URL, in the caller's order. */
	source_providers: string[];
	/** 1-based rank in each contributing provider's list. */
	ranks: Record<string, number>;
	/** The fused score; higher is better. */
	score: number;
}

export interface RankedList {
	provider: string;
	results: SearchResult[];
}

export interface FusionOutcome {
	results: FusedResult[];
	/** Distinct URLs seen before the limit was applied. */
	candidates: number;
	/** Results dropped because their URL had already been listed. */
	duplicates_removed: number;
	/** Results dropped because they carried no usable http(s) URL. */
	unaddressed: number;
}

interface Entry extends FusedResult {
	order: number;
}

const prefer = (current: string, candidate: string) =>
	current.trim() ? current : candidate;

export const fuse_results = (
	lists: RankedList[],
	options: { limit: number; k?: number },
): FusionOutcome => {
	const k = options.k ?? RRF_K;
	const entries = new Map<string, Entry>();
	let duplicates_removed = 0;
	let unaddressed = 0;
	for (const { provider, results } of lists) {
		let rank = 0;
		for (const result of results) {
			const key = canonical_url(result.url);
			if (!key) {
				unaddressed++;
				continue;
			}
			rank++;
			const existing = entries.get(key);
			if (existing) {
				if (existing.ranks[provider] !== undefined) {
					duplicates_removed++;
					continue;
				}
				existing.score += 1 / (k + rank);
				existing.source_providers.push(provider);
				existing.ranks[provider] = rank;
				existing.title = prefer(existing.title, result.title);
				existing.snippet = prefer(existing.snippet, result.snippet);
				continue;
			}
			entries.set(key, {
				title: result.title,
				url: result.url,
				snippet: result.snippet,
				...(result.metadata ? { metadata: result.metadata } : {}),
				source_provider: provider,
				canonical_url: key,
				source_providers: [provider],
				ranks: { [provider]: rank },
				score: 1 / (k + rank),
				order: entries.size,
			});
		}
	}
	const best_rank = (entry: Entry) =>
		Math.min(...Object.values(entry.ranks));
	const ranked = [...entries.values()].sort(
		(a, b) =>
			b.score - a.score ||
			b.source_providers.length - a.source_providers.length ||
			best_rank(a) - best_rank(b) ||
			a.order - b.order,
	);
	return {
		results: ranked
			.slice(0, options.limit)
			.map(({ order: _order, ...entry }) => ({
				...entry,
				score: Number(entry.score.toFixed(6)),
			})),
		candidates: entries.size,
		duplicates_removed,
		unaddressed,
	};
};
