import * as v from 'valibot';
import { http_json } from './http.js';
import { parse_provider_response } from './provider_response.js';
import {
	get_request_signal,
	throw_if_aborted,
} from './request_context.js';
import {
	get_response_metadata,
	merge_response_metadata,
} from './response_metadata.js';
import { ProcessingResult, ProviderError } from './types.js';
import { is_valid_url } from './validation.js';

/**
 * Opt-in recovery for pages a provider reports gone. The only host this
 * module contacts is archive.org, fixed here and never caller-controlled:
 * the caller's URL travels as a query parameter of the Wayback
 * availability lookup, and the snapshot is then read by the same paid
 * provider that reported the page gone. This server still never fetches
 * a caller-supplied URL itself.
 */

export const WAYBACK_AVAILABILITY_URL =
	'https://archive.org/wayback/available';
const WAYBACK_HOST = 'web.archive.org';
const WAYBACK_TIMEOUT_MS = 10_000;
const WAYBACK_MAX_RESPONSE_BYTES = 64 * 1024;
const WAYBACK_PROVIDER = 'wayback';

/** HTTP statuses that mean the page itself is gone. */
export const is_gone_status = (status: unknown): boolean =>
	status === 404 || status === 410;

/** Provider failure text that reports the page gone, for providers
 * that return no status code (Tavily). Only fixed patterns, and the
 * text itself is never stored. */
export const is_gone_message = (text: unknown): boolean =>
	typeof text === 'string' &&
	(/\b(404|410)\b/.test(text) || /not found|\bgone\b/i.test(text));

/** The URLs a result or a thrown provider error reports gone. */
export const gone_urls_of = (value: unknown): string[] => {
	const source =
		value instanceof ProviderError
			? value.details
			: value && typeof value === 'object'
				? (value as { metadata?: unknown }).metadata
				: undefined;
	const listed =
		source && typeof source === 'object'
			? (source as { gone_urls?: unknown }).gone_urls
			: undefined;
	return Array.isArray(listed)
		? [
				...new Set(
					listed.filter(
						(item): item is string =>
							typeof item === 'string' && is_valid_url(item),
					),
				),
			]
		: [];
};

const availability_schema = v.looseObject({
	archived_snapshots: v.optional(
		v.looseObject({
			closest: v.optional(
				v.nullable(
					v.looseObject({
						available: v.optional(v.boolean()),
						url: v.optional(v.string()),
						timestamp: v.optional(v.string()),
						status: v.optional(v.string()),
					}),
				),
			),
		}),
	),
});

export interface WaybackSnapshot {
	/** The page the caller asked for. */
	url: string;
	/** The snapshot as the Wayback Machine presents it. */
	snapshot_url: string;
	/** The raw archived page (`id_` flag), what the provider reads. */
	extract_url: string;
	/** Snapshot capture time, ISO 8601 UTC. */
	timestamp: string;
}

const snapshot_path =
	/^\/web\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[a-z]{2}_)?\/(https?:\/\/.+)$/;

/**
 * Accept only a snapshot on web.archive.org with a parsable timestamp
 * and an http(s) target; anything else is treated as unavailable.
 */
export const parse_wayback_snapshot = (
	url: string,
	raw: unknown,
): WaybackSnapshot | undefined => {
	const closest = v.safeParse(availability_schema, raw);
	const snapshot = closest.success
		? closest.output.archived_snapshots?.closest
		: undefined;
	if (!snapshot || snapshot.available !== true || !snapshot.url)
		return undefined;
	let parsed: URL;
	try {
		parsed = new URL(snapshot.url);
	} catch {
		return undefined;
	}
	if (
		(parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
		parsed.hostname !== WAYBACK_HOST
	)
		return undefined;
	const match = snapshot_path.exec(parsed.pathname + parsed.search);
	if (!match) return undefined;
	const [, year, month, day, hour, minute, second, target] = match;
	const captured = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second),
	);
	if (!Number.isFinite(captured)) return undefined;
	const stamp = `${year}${month}${day}${hour}${minute}${second}`;
	return {
		url,
		snapshot_url: `https://${WAYBACK_HOST}/web/${stamp}/${target}`,
		extract_url: `https://${WAYBACK_HOST}/web/${stamp}id_/${target}`,
		timestamp: new Date(captured).toISOString(),
	};
};

/**
 * Ask archive.org for the closest snapshot of `url`. Lookup failures
 * (network, archive.org errors, malformed answers) mean "unavailable";
 * only cancellation of the caller's request propagates.
 */
export const lookup_wayback_snapshot = async (
	url: string,
): Promise<WaybackSnapshot | undefined> => {
	try {
		const raw = await http_json(
			WAYBACK_PROVIDER,
			`${WAYBACK_AVAILABILITY_URL}?url=${encodeURIComponent(url)}`,
			{
				method: 'GET',
				headers: { Accept: 'application/json' },
				redirect: 'error',
				max_response_bytes: WAYBACK_MAX_RESPONSE_BYTES,
				signal: AbortSignal.timeout(WAYBACK_TIMEOUT_MS),
			},
		);
		return parse_wayback_snapshot(
			url,
			parse_provider_response(
				WAYBACK_PROVIDER,
				availability_schema,
				raw,
			),
		);
	} catch (error) {
		throw_if_aborted(get_request_signal());
		if (
			error instanceof Error &&
			(error.name === 'AbortError' ||
				error.name === 'TimeoutError') &&
			get_request_signal()?.aborted
		)
			throw error;
		return undefined;
	}
};

export interface ArchiveFallbackSummary {
	attempted: string[];
	recovered: string[];
	unavailable: string[];
	/** Set when snapshots were found but reading them failed. */
	failed?: true;
}

const unique = (items: string[]) => [...new Set(items)];

const reconstructible = (result: ProcessingResult) =>
	Array.isArray(result.raw_contents) &&
	result.raw_contents.length > 0 &&
	result.content ===
		result.raw_contents.map((item) => item.content).join('\n\n');

const word_count = (text: string) =>
	text.split(/\s+/).filter(Boolean).length;

const annotate = (
	result: ProcessingResult,
	summary: ArchiveFallbackSummary,
): ProcessingResult => ({
	...result,
	metadata: { ...result.metadata, archive_fallback: summary },
});

/**
 * Run an extraction; when the provider reports some of the URLs gone,
 * look each one up on the Wayback Machine and read the snapshots with
 * the same provider. The merged result keeps live sources first, lists
 * every recovered page under `metadata.archived` with its snapshot
 * timestamp, and reports what was attempted. If nothing can be
 * recovered the original outcome stands, including its error.
 */
export const with_archive_fallback = async (
	urls: string[],
	run: (targets: string[]) => Promise<ProcessingResult>,
): Promise<ProcessingResult> => {
	let live: ProcessingResult | undefined;
	let failure: unknown;
	try {
		live = await run(urls);
	} catch (error) {
		throw_if_aborted(get_request_signal());
		failure = error;
	}
	const gone = gone_urls_of(live ?? failure).filter((url) =>
		urls.includes(url),
	);
	if (!gone.length) {
		if (failure) throw failure;
		return live!;
	}
	const snapshots = (
		await Promise.all(gone.map(lookup_wayback_snapshot))
	).filter((snapshot): snapshot is WaybackSnapshot =>
		Boolean(snapshot),
	);
	const summary: ArchiveFallbackSummary = {
		attempted: gone,
		recovered: [],
		unavailable: gone.filter(
			(url) => !snapshots.some((snapshot) => snapshot.url === url),
		),
	};
	if (!snapshots.length) {
		if (failure) throw failure;
		return annotate(live!, summary);
	}
	let archived: ProcessingResult;
	try {
		archived = await run(snapshots.map((item) => item.extract_url));
	} catch (error) {
		throw_if_aborted(get_request_signal());
		if (failure) throw failure;
		return annotate(live!, { ...summary, failed: true });
	}
	const read = new Set(
		(archived.raw_contents ?? []).map((item) => item.url),
	);
	const recovered = snapshots.filter(
		(snapshot) =>
			read.size === 0 ||
			read.has(snapshot.extract_url) ||
			read.has(snapshot.snapshot_url),
	);
	summary.recovered = recovered.map((snapshot) => snapshot.url);
	summary.unavailable = unique([
		...summary.unavailable,
		...snapshots
			.filter((snapshot) => !recovered.includes(snapshot))
			.map((snapshot) => snapshot.url),
	]);
	const archived_entries = recovered.map((snapshot) => ({
		url: snapshot.url,
		snapshot_url: snapshot.snapshot_url,
		extract_url: snapshot.extract_url,
		timestamp: snapshot.timestamp,
	}));
	const failed_urls = unique([
		...(Array.isArray(live?.metadata.failed_urls)
			? live.metadata.failed_urls
			: []),
		...summary.unavailable,
	]).filter((url) => !summary.recovered.includes(url));
	// The key is absent, not undefined, when nothing failed.
	const failed = failed_urls.length ? { failed_urls } : {};
	if (!live) {
		const { failed_urls: _archived_failures, ...rest } =
			archived.metadata;
		const result: ProcessingResult = {
			...archived,
			metadata: {
				...rest,
				urls_processed: urls.length,
				...failed,
				archived: archived_entries,
				archive_fallback: summary,
			},
		};
		merge_response_metadata(result, [archived]);
		return result;
	}
	// A recovered page replaces whatever the provider returned for it,
	// such as the body of a 404 page.
	const live_contents = (live.raw_contents ?? []).filter(
		(item) => !summary.recovered.includes(item.url),
	);
	const raw_contents = [
		...live_contents,
		...(archived.raw_contents ?? []),
	];
	const content = reconstructible(live)
		? raw_contents.map((item) => item.content).join('\n\n')
		: [live.content, archived.content]
				.filter((text) => text.trim())
				.join('\n\n');
	const documents = [
		...(Array.isArray(live.metadata.documents)
			? live.metadata.documents.filter(
					(item: { url?: unknown }) =>
						typeof item?.url !== 'string' ||
						!summary.recovered.includes(item.url),
				)
			: []),
		...(Array.isArray(archived.metadata.documents)
			? archived.metadata.documents
			: []),
	];
	const { failed_urls: _live_failures, ...live_metadata } =
		live.metadata;
	const result: ProcessingResult = {
		content,
		raw_contents,
		metadata: {
			...live_metadata,
			word_count: word_count(content),
			...failed,
			successful_extractions:
				live_contents.length + (archived.raw_contents?.length ?? 0),
			...(documents.length ? { documents } : {}),
			archived: archived_entries,
			archive_fallback: summary,
		},
		source_provider: live.source_provider,
	};
	if (get_response_metadata(live) || get_response_metadata(archived))
		merge_response_metadata(result, [live, archived]);
	return result;
};
