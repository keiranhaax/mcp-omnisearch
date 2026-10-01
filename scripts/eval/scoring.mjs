// Scoring for the fixed search evaluation set. Pure functions over a
// query manifest and a recorded run; no network, no provider code. The
// CLI in scripts/eval-search.mjs and the offline tests both import it.
// URL canonicalisation mirrors src/common/canonical_url.ts, which the
// server uses for result fusion; a test keeps the two in agreement.

const TRACKING_PARAM =
	/^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|twclid|ttclid|_ga|_gl|_hsenc|_hsmi|hsa_[a-z0-9_]+|s_kwcid|ref_src|ref_url|srsltid)$/i;

/**
 * Canonical form for comparing result URLs: http(s) only, lowercase
 * host, default port and fragment dropped, tracking parameters
 * removed, trailing slash removed. Returns undefined for anything that
 * is not an absolute http(s) URL.
 */
export const canonical_url = (raw) => {
	if (typeof raw !== 'string') return undefined;
	let url;
	try {
		url = new URL(raw.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		return undefined;
	for (const name of [...url.searchParams.keys()])
		if (TRACKING_PARAM.test(name)) url.searchParams.delete(name);
	const path = url.pathname.replace(/\/+$/, '');
	return `${url.protocol}//${url.host}${path}${url.search}`;
};

const escape_regex = (text) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const anchor_pattern = (anchor) => {
	// `*` matches within one path segment; the anchor matches exactly or
	// as a prefix ending at a path or query boundary.
	const pieces = anchor.split('*').map(escape_regex);
	return new RegExp(`^${pieces.join('[^/?]*')}(?:[/?].*)?$`);
};

const canonical_anchor = (anchor) => {
	const wildcard = anchor.includes('*');
	const canonical = canonical_url(
		wildcard ? anchor.replaceAll('*', 'WILDCARD') : anchor,
	);
	return canonical?.replaceAll('WILDCARD', '*');
};

/** Whether a result URL counts as correct for the given anchors. */
export const anchor_hit = (raw_url, anchors) => {
	const url = canonical_url(raw_url);
	if (!url) return false;
	const host = new URL(url).hostname;
	for (const domain of anchors.domains ?? []) {
		const wanted = domain.toLowerCase();
		if (host === wanted || host.endsWith(`.${wanted}`)) return true;
	}
	for (const anchor of anchors.urls ?? []) {
		const canonical = canonical_anchor(anchor);
		if (canonical && anchor_pattern(canonical).test(url)) return true;
	}
	return false;
};

/** 1-based rank of the first correct URL, or null when none hits. */
export const first_hit_rank = (urls, anchors) => {
	for (let index = 0; index < urls.length; index++)
		if (anchor_hit(urls[index], anchors)) return index + 1;
	return null;
};

const is_amount = (value) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

const round = (value, places = 4) =>
	value === null ? null : Number(value.toFixed(places));

const percentile = (sorted, fraction) =>
	sorted.length
		? sorted[
				Math.min(
					sorted.length - 1,
					Math.max(0, Math.ceil(sorted.length * fraction) - 1),
				)
			]
		: null;

const summarise = (rows) => {
	const n = rows.length;
	const answered = rows.filter((row) => row.status === 'ok');
	const latencies = answered
		.map((row) => row.latency_ms)
		.filter(is_amount)
		.sort((a, b) => a - b);
	const cost = {
		usd: 0,
		credits: 0,
		reported_calls: 0,
		unreported_calls: 0,
	};
	for (const row of answered) {
		const usage = row.usage;
		let reported = false;
		if (usage && is_amount(usage.usd)) {
			cost.usd += usage.usd;
			reported = true;
		}
		if (usage && is_amount(usage.credits)) {
			cost.credits += usage.credits;
			reported = true;
		}
		if (reported) cost.reported_calls++;
		else cost.unreported_calls++;
	}
	const sum = (pick) =>
		rows.reduce((total, row) => total + pick(row), 0);
	return {
		queries: n,
		answered: answered.length,
		failed: rows.filter((row) => row.status === 'error').length,
		skipped: rows.filter((row) => row.status === 'skipped').length,
		missing: rows.filter((row) => row.status === 'missing').length,
		hit_at_1: n
			? round(sum((row) => (row.hit_at_1 ? 1 : 0)) / n)
			: null,
		hit_at_5: n
			? round(sum((row) => (row.hit_at_5 ? 1 : 0)) / n)
			: null,
		mrr: n ? round(sum((row) => row.reciprocal_rank) / n) : null,
		latency_ms: {
			samples: latencies.length,
			mean: latencies.length
				? Math.round(
						latencies.reduce((a, b) => a + b, 0) / latencies.length,
					)
				: null,
			p50: percentile(latencies, 0.5),
			p95: percentile(latencies, 0.95),
			max: latencies.length ? latencies[latencies.length - 1] : null,
		},
		cost: {
			usd: round(cost.usd, 6),
			credits: round(cost.credits, 6),
			reported_calls: cost.reported_calls,
			unreported_calls: cost.unreported_calls,
		},
	};
};

/**
 * Score a recorded run against the manifest. Every manifest query
 * counts for every provider that appears in the run; a query the run
 * never answered scores as a miss and is reported as `missing`.
 */
export const score_run = (manifest, run, options = {}) => {
	const top_k = options.top_k ?? run.top_k ?? 10;
	const queries = new Map(
		manifest.queries.map((query) => [query.id, query]),
	);
	const providers = [
		...new Set((run.records ?? []).map((record) => record.provider)),
	].sort();
	const seen = new Set();
	const rows = [];
	for (const record of run.records ?? []) {
		const query = queries.get(record.query_id);
		const key = `${record.provider}\n${record.query_id}`;
		if (!query || seen.has(key)) continue;
		seen.add(key);
		const urls =
			record.status === 'ok' && Array.isArray(record.urls)
				? record.urls.slice(0, top_k)
				: [];
		const rank = first_hit_rank(urls, query.anchors);
		rows.push({
			query_id: query.id,
			category: query.category,
			provider: record.provider,
			status: record.status,
			...(record.error_kind ? { error_kind: record.error_kind } : {}),
			rank,
			hit_at_1: rank === 1,
			hit_at_5: rank !== null && rank <= 5,
			reciprocal_rank: rank === null ? 0 : round(1 / rank, 6),
			latency_ms: is_amount(record.latency_ms)
				? Math.round(record.latency_ms)
				: null,
			usage: record.usage ?? null,
			first_url: urls[0] ?? null,
		});
	}
	for (const provider of providers)
		for (const query of manifest.queries)
			if (!seen.has(`${provider}\n${query.id}`))
				rows.push({
					query_id: query.id,
					category: query.category,
					provider,
					status: 'missing',
					rank: null,
					hit_at_1: false,
					hit_at_5: false,
					reciprocal_rank: 0,
					latency_ms: null,
					usage: null,
					first_url: null,
				});
	const categories = [
		...new Set(manifest.queries.map((query) => query.category)),
	];
	const scores = {};
	for (const provider of providers) {
		const mine = rows.filter((row) => row.provider === provider);
		scores[provider] = {
			...summarise(mine),
			by_category: Object.fromEntries(
				categories.map((category) => [
					category,
					summarise(mine.filter((row) => row.category === category)),
				]),
			),
		};
	}
	return {
		version: 1,
		manifest: {
			version: manifest.version,
			queries: manifest.queries.length,
			categories: Object.fromEntries(
				categories.map((category) => [
					category,
					manifest.queries.filter(
						(query) => query.category === category,
					).length,
				]),
			),
		},
		run: {
			mode: run.mode ?? 'unknown',
			started_at: run.started_at ?? null,
			records: (run.records ?? []).length,
		},
		top_k,
		providers: scores,
		queries: rows,
	};
};

const cell = (value, places = 2) =>
	value === null || value === undefined
		? '-'
		: typeof value === 'number'
			? Number.isInteger(value)
				? String(value)
				: value.toFixed(places)
			: String(value);

/** A Markdown summary of a scored report. */
export const render_markdown = (report) => {
	const lines = [
		'# Search evaluation report',
		'',
		`- Run: ${report.run.mode}, started ${report.run.started_at ?? 'unknown'}, ${report.run.records} records, top-${report.top_k}`,
		`- Manifest: version ${report.manifest.version}, ${report.manifest.queries} queries (${Object.entries(
			report.manifest.categories,
		)
			.map(([category, count]) => `${category} ${count}`)
			.join(', ')})`,
		'- Latency is wall-clock per call as seen by the client; cost is the provider-reported usage only. Providers that report nothing show as unreported.',
		'',
		'| Provider | Queries | Answered | hit@1 | hit@5 | MRR | p50 ms | mean ms | USD | Credits | Reported |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
	];
	for (const [provider, score] of Object.entries(report.providers))
		lines.push(
			`| ${provider} | ${score.queries} | ${score.answered} | ${cell(score.hit_at_1)} | ${cell(score.hit_at_5)} | ${cell(score.mrr)} | ${cell(score.latency_ms.p50)} | ${cell(score.latency_ms.mean)} | ${cell(score.cost.usd, 4)} | ${cell(score.cost.credits)} | ${score.cost.reported_calls}/${score.answered} |`,
		);
	lines.push('', '## By category', '');
	lines.push(
		'| Provider | Category | Queries | Answered | hit@1 | hit@5 | MRR |',
		'| --- | --- | ---: | ---: | ---: | ---: | ---: |',
	);
	for (const [provider, score] of Object.entries(report.providers))
		for (const [category, part] of Object.entries(score.by_category))
			lines.push(
				`| ${provider} | ${category} | ${part.queries} | ${part.answered} | ${cell(part.hit_at_1)} | ${cell(part.hit_at_5)} | ${cell(part.mrr)} |`,
			);
	const misses = report.queries.filter((row) => row.rank === null);
	lines.push('', `## Misses (${misses.length})`, '');
	if (misses.length) {
		lines.push(
			'| Provider | Query | Status | First URL |',
			'| --- | --- | --- | --- |',
		);
		for (const row of misses)
			lines.push(
				`| ${row.provider} | ${row.query_id} | ${row.status}${row.error_kind ? ` (${row.error_kind})` : ''} | ${row.first_url ?? '-'} |`,
			);
	} else lines.push('None.');
	return `${lines.join('\n')}\n`;
};
