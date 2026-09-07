export interface Passage {
	start: number;
	end: number;
	text: string;
}

function splits_surrogate(text: string, offset: number): boolean {
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return (
		before >= 0xd800 &&
		before <= 0xdbff &&
		after >= 0xdc00 &&
		after <= 0xdfff
	);
}

function window_at(
	text: string,
	index: number,
	length: number,
	size: number,
): Passage {
	let start = Math.max(
		0,
		index - Math.floor(Math.max(0, size - length) / 2),
	);
	if (splits_surrogate(text, start)) start++;
	let end = Math.min(text.length, start + size);
	if (splits_surrogate(text, end)) end--;
	return { start, end, text: text.slice(start, end) };
}

type Span = { start: number; end: number };

function atomic_spans(text: string): Span[] {
	const spans: Span[] = [];
	let start = 0;
	let paragraph_start = 0;
	let fence: { start: number; marker: string } | undefined;
	while (start < text.length) {
		const newline = text.indexOf('\n', start);
		const end = newline < 0 ? text.length : newline + 1;
		const line = text.slice(start, end);
		const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
		if (fence) {
			if (
				marker &&
				marker[1][0] === fence.marker[0] &&
				marker[1].length >= fence.marker.length &&
				marker[2].trim() === ''
			) {
				spans.push({ start: fence.start, end });
				fence = undefined;
			}
		} else if (
			marker &&
			(marker[1][0] !== '`' || !marker[2].includes('`'))
		) {
			fence = { start, marker: marker[1] };
		} else if (/^ {0,3}#{1,6}(?:[ 	]|\r?\n|$)/.test(line)) {
			spans.push({ start, end });
			paragraph_start = end;
		} else if (
			paragraph_start < start &&
			/^ {0,3}(?:=+|-+)[ 	]*\r?\n?$/.test(line)
		) {
			spans.push({ start: paragraph_start, end });
			paragraph_start = end;
		}
		if (fence || marker || !line.trim()) paragraph_start = end;
		start = end;
	}
	if (fence) spans.push({ start: fence.start, end: text.length });
	// Protect URL/Markdown citation tokens conservatively as whitespace
	// units. Overlapping atoms merge so code and headings remain intact.
	for (const match of text.matchAll(/\S+/gu)) {
		if (/https?:\/\/|\[|\]/i.test(match[0])) {
			spans.push({
				start: match.index,
				end: match.index + match[0].length,
			});
		}
	}
	spans.sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
	const merged: Span[] = [];
	for (const span of spans) {
		const previous = merged.at(-1);
		if (previous && span.start < previous.end)
			previous.end = Math.max(previous.end, span.end);
		else merged.push({ ...span });
	}
	return merged;
}

// Atoms are disjoint and ordered. Avoid rescanning every heading for
// every hit in large documents.
function atom_at(spans: Span[], offset: number): Span | undefined {
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (spans[middle].end <= offset) low = middle + 1;
		else high = middle;
	}
	const span = spans[low];
	return span && span.start <= offset ? span : undefined;
}

function preserve_atoms(
	passage: Passage,
	spans: Span[],
	text: string,
	budget: number,
): Passage {
	let { start, end } = passage;
	const first = atom_at(spans, start);
	if (first && start > first.start) {
		start = end - first.start <= budget ? first.start : first.end;
	}
	const last = atom_at(spans, end);
	if (last && end > last.start) {
		end = last.end - start <= budget ? last.end : last.start;
	}
	end = Math.max(start, end);
	return { start, end, text: text.slice(start, end) };
}

/**
 * Select original UTF-16 slices; callers own normalization and byte caps.
 * Query terms are literal Unicode word/emoji substrings (not regex, stemming,
 * or semantic search). More distinct terms win, then earlier source offsets.
 * Work uses only the first 4096 query units / 32 distinct terms, one sampled
 * hit per term per 200-unit bucket (or Markdown atom), and at most 128 output
 * ranges. Ordinary context is 400 units; a longer hit or whole atom may grow
 * to the budget. Overlaps/adjacency merge before source-order presentation.
 * ATX/Setext headings and top-level backtick/tilde fences are atomic. This
 * deliberately is not a full Markdown parser (e.g. nested list/quote fences).
 * Unclosed fences extend to EOF. Oversized atoms are omitted, never cut.
 * Missing/blank queries use a leading preview; unmatched queries use the same
 * preview labelled no_hit. A found but unselectable hit still reports query.
 * Invalid budgets throw RangeError; zero selects nothing.
 */
export function select_passages(
	text: string,
	query?: string,
	max_chars = 4000,
): {
	passages: Passage[];
	method: 'query' | 'leading' | 'no_hit';
	omitted: boolean;
} {
	if (!Number.isSafeInteger(max_chars) || max_chars < 0) {
		throw new RangeError(
			'max_chars must be a nonnegative safe integer',
		);
	}
	const spans = atomic_spans(text);
	const term = query?.slice(0, 4096).trim();
	const terms = [
		...new Set(
			(
				term?.match(
					/[\p{L}\p{N}\p{M}_]+|[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu,
				) ?? []
			).map((value) =>
				Array.from(value)
					.map((letter) => {
						const lower = letter.toLowerCase();
						return Array.from(lower).length === 1 ? lower : letter;
					})
					.join(''),
			),
		),
	]
		.slice(0, 32)
		.sort();
	const patterns = terms.map((value) => new RegExp(value, 'giu'));
	const relevance_patterns = terms.map(
		(value) => new RegExp(value, 'iu'),
	);
	const candidates = new Map<
		number,
		{ passage: Passage; score: number }
	>();
	for (const pattern of patterns) {
		let hit;
		while ((hit = pattern.exec(text))) {
			const bucket = Math.floor(hit.index / 200);
			const atom = atom_at(spans, hit.index);
			let candidate = preserve_atoms(
				window_at(
					text,
					hit.index,
					hit[0].length,
					Math.min(Math.max(400, hit[0].length), max_chars),
				),
				spans,
				text,
				max_chars,
			);
			if (
				atom &&
				atom.end - atom.start <= max_chars &&
				(candidate.start > hit.index ||
					candidate.end < hit.index + hit[0].length)
			) {
				candidate = {
					...atom,
					text: text.slice(atom.start, atom.end),
				};
			}
			if (
				candidate.start > hit.index ||
				candidate.end < hit.index + hit[0].length
			) {
				candidate.end = candidate.start;
				candidate.text = '';
			}
			const score = relevance_patterns.filter((relevance) =>
				relevance.test(candidate.text),
			).length;
			const previous = candidates.get(bucket);
			if (
				!previous ||
				score > previous.score ||
				(score === previous.score &&
					candidate.start < previous.passage.start)
			)
				candidates.set(bucket, { passage: candidate, score });
			pattern.lastIndex = Math.max(
				pattern.lastIndex,
				atom?.end ?? (bucket + 1) * 200,
			);
		}
	}
	const ranked = [...candidates.values()].sort(
		(a, b) => b.score - a.score || a.passage.start - b.passage.start,
	);
	let selected: Span[] = [];
	let used = 0;
	for (const { passage } of ranked) {
		if (selected.length >= 128) break;
		const overlaps = selected.filter(
			(other) =>
				other.start <= passage.end && other.end >= passage.start,
		);
		const start = Math.min(
			passage.start,
			...overlaps.map((other) => other.start),
		);
		const end = Math.max(
			passage.end,
			...overlaps.map((other) => other.end),
		);
		const extra =
			end -
			start -
			overlaps.reduce(
				(sum, other) => sum + other.end - other.start,
				0,
			);
		if (used + extra > max_chars || end === start) continue;
		selected = selected.filter(
			(other) => other.start > end || other.end < start,
		);
		selected.push({ start, end });
		used += extra;
	}
	if (ranked.length === 0) {
		const passage = preserve_atoms(
			window_at(text, 0, 0, max_chars),
			spans,
			text,
			max_chars,
		);
		if (passage.text.length > 0) selected.push(passage);
	}
	selected.sort((a, b) => a.start - b.start);
	const passages = selected.map(({ start, end }) => ({
		start,
		end,
		text: text.slice(start, end),
	}));
	return {
		passages,
		method: ranked.length ? 'query' : term ? 'no_hit' : 'leading',
		omitted:
			passages.reduce(
				(sum, passage) => sum + passage.end - passage.start,
				0,
			) !== text.length,
	};
}
