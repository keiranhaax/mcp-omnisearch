/**
 * Canonical form for comparing result URLs across providers: http(s)
 * only, lowercase host, default port and fragment dropped, tracking
 * parameters removed, trailing slash removed. Query order and the rest
 * of the path are kept as given, since they may be meaningful.
 * `scripts/eval/scoring.mjs` carries the same rules for the offline
 * scorer; a test keeps the two in agreement.
 */

const TRACKING_PARAM =
	/^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|twclid|ttclid|_ga|_gl|_hsenc|_hsmi|hsa_[a-z0-9_]+|s_kwcid|ref_src|ref_url|srsltid)$/i;

export const canonical_url = (raw: unknown): string | undefined => {
	if (typeof raw !== 'string') return undefined;
	let url: URL;
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
