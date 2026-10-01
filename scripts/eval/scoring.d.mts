// Types for scoring.mjs so the offline tests under src/ can import it
// without enabling JavaScript compilation for the whole project.

export interface EvalAnchors {
	urls?: string[];
	domains?: string[];
}

export interface EvalQuery {
	id: string;
	category: string;
	query: string;
	anchors: EvalAnchors;
	notes?: string;
}

export interface EvalManifest {
	version: number;
	queries: EvalQuery[];
	[key: string]: unknown;
}

export interface EvalUsage {
	usd?: number;
	credits?: number;
}

export interface EvalRecord {
	query_id: string;
	provider: string;
	status: 'ok' | 'error' | 'skipped';
	urls?: string[];
	latency_ms?: number | null;
	usage?: EvalUsage | null;
	error_kind?: string;
}

export interface EvalRun {
	version?: number;
	mode?: string;
	started_at?: string;
	top_k?: number;
	records: EvalRecord[];
	[key: string]: unknown;
}

export interface EvalSummary {
	queries: number;
	answered: number;
	failed: number;
	skipped: number;
	missing: number;
	hit_at_1: number | null;
	hit_at_5: number | null;
	mrr: number | null;
	latency_ms: {
		samples: number;
		mean: number | null;
		p50: number | null;
		p95: number | null;
		max: number | null;
	};
	cost: {
		usd: number;
		credits: number;
		reported_calls: number;
		unreported_calls: number;
	};
}

export interface EvalProviderScore extends EvalSummary {
	by_category: Record<string, EvalSummary>;
}

export interface EvalQueryRow {
	query_id: string;
	category: string;
	provider: string;
	status: 'ok' | 'error' | 'skipped' | 'missing';
	error_kind?: string;
	rank: number | null;
	hit_at_1: boolean;
	hit_at_5: boolean;
	reciprocal_rank: number;
	latency_ms: number | null;
	usage: EvalUsage | null;
	first_url: string | null;
}

export interface EvalReport {
	version: 1;
	manifest: {
		version: number;
		queries: number;
		categories: Record<string, number>;
	};
	run: { mode: string; started_at: string | null; records: number };
	top_k: number;
	providers: Record<string, EvalProviderScore>;
	queries: EvalQueryRow[];
}

export function canonical_url(raw: unknown): string | undefined;
export function anchor_hit(
	raw_url: string,
	anchors: EvalAnchors,
): boolean;
export function first_hit_rank(
	urls: string[],
	anchors: EvalAnchors,
): number | null;
export function score_run(
	manifest: EvalManifest,
	run: EvalRun,
	options?: { top_k?: number },
): EvalReport;
export function render_markdown(report: EvalReport): string;
