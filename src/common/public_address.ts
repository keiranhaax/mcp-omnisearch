import { BlockList, isIP } from 'node:net';
import { ErrorType, ProviderError } from './types.js';

const address_ranges = (
	cidrs: string[],
	family: 'ipv4' | 'ipv6',
): BlockList => {
	const ranges = new BlockList();
	for (const cidr of cidrs) {
		const [address, prefix] = cidr.split('/');
		ranges.addSubnet(address, Number(prefix), family);
	}
	return ranges;
};

// Reviewed 2026-09-07 against IANA (including globally reachable
// special-purpose exceptions, which this policy deliberately excludes):
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const ipv4_excluded = address_ranges(
	[
		'0.0.0.0/8', // This network / unspecified.
		'10.0.0.0/8', // Private.
		'100.64.0.0/10', // Shared / CGNAT.
		'127.0.0.0/8', // Loopback.
		'168.63.129.16/32', // Additional cloud platform endpoint denial.
		'169.254.0.0/16', // Link local, including metadata endpoints.
		'172.16.0.0/12', // Private.
		'192.0.0.0/24', // Protocol assignments, including anycast.
		'192.0.2.0/24', // Documentation.
		'192.31.196.0/24', // AS112.
		'192.52.193.0/24', // AMT.
		'192.88.99.0/24', // Deprecated 6to4 / 6a44.
		'192.168.0.0/16', // Private.
		'192.175.48.0/24', // AS112.
		'198.18.0.0/15', // Benchmarking.
		'198.51.100.0/24', // Documentation.
		'203.0.113.0/24', // Documentation.
		'224.0.0.0/4', // Multicast.
		'240.0.0.0/4', // Reserved, including limited broadcast.
	],
	'ipv4',
);

// Only IANA allocations to RIRs, not all of 2000::/3. Future
// allocations fail closed until reviewed; allocation is not proof of
// reachability. Excludes mapped/compatible, NAT64, discard, local,
// multicast, Teredo, 6to4, old 6bone and reserved/unallocated space.
// https://www.iana.org/assignments/ipv6-unicast-address-assignments/
const ipv6_allocated = address_ranges(
	[
		'2001:200::/23',
		'2001:400::/23',
		'2001:600::/23',
		'2001:800::/22',
		'2001:c00::/23',
		'2001:e00::/23',
		'2001:1200::/23',
		'2001:1400::/22',
		'2001:1800::/23',
		'2001:1a00::/23',
		'2001:1c00::/22',
		'2001:2000::/19',
		'2001:4000::/23',
		'2001:4200::/23',
		'2001:4400::/23',
		'2001:4600::/23',
		'2001:4800::/23',
		'2001:4a00::/23',
		'2001:4c00::/23',
		'2001:5000::/20',
		'2001:8000::/19',
		'2001:a000::/20',
		'2001:b000::/20',
		'2003::/18',
		'2400::/12',
		'2410::/12',
		'2600::/12',
		'2610::/23',
		'2620::/23',
		'2630::/12',
		'2800::/12',
		'2a00::/12',
		'2a10::/12',
		'2c00::/12',
	],
	'ipv6',
);
const ipv6_excluded = address_ranges(
	['2001:db8::/32', '2620:4f:8000::/48'], // Documentation / AS112.
	'ipv6',
);

/** Classify one bare IP, never a hostname, scope ID or address set. */
export const is_public_address = (address: string): boolean => {
	if (typeof address !== 'string' || address.includes('%'))
		return false;
	const family = isIP(address);
	if (family === 4) return !ipv4_excluded.check(address, 'ipv4');
	if (
		family !== 6 ||
		!ipv6_allocated.check(address, 'ipv6') ||
		ipv6_excluded.check(address, 'ipv6')
	)
		return false;

	// ISATAP can embed IPv4 under an otherwise global prefix. Inspect
	// the interface ID after canonicalizing any dotted IPv4 tail.
	const canonical = new URL(`http://[${address}]/`).hostname.slice(
		1,
		-1,
	);
	const [head, tail = ''] = canonical.split('::');
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const words = [
		...left,
		...Array<string>(8 - left.length - right.length).fill('0'),
		...right,
	].map((word) => Number.parseInt(word, 16));
	return !(
		(words[4] === 0 || words[4] === 0x200) &&
		words[5] === 0x5efe
	);
};

const unsafe_url = (): never => {
	throw new ProviderError(
		ErrorType.INVALID_INPUT,
		'Invalid URL provided; use a public HTTP(S) URL without credentials',
		'defuddle',
		{ retryable: false, cause: 'unsafe_url' },
	);
};

/**
 * Syntactic policy only: the caller must resolve names, reject ANY
 * non-public answer, pin the checked address and recheck redirects.
 * Deployment-specific NAT64 prefixes/routing also need egress policy.
 */
export const parse_public_url = (input: string): URL => {
	if (
		typeof input !== 'string' ||
		input.length > 4096 ||
		/[\s\p{Cc}\\]/u.test(input) ||
		/%(?![a-f0-9]{2})/i.test(input)
	)
		return unsafe_url();

	// Inspect authority BEFORE WHATWG normalization can erase empty
	// userinfo, scopes, encoded delimiters, empty ports or numeric forms.
	const authority = /^https?:\/\/([^/?#]+)/i.exec(input)?.[1];
	const host = authority
		? /^(\[[a-f0-9:.]+\]|[\p{L}\p{M}\p{N}.-]+)(?::(?:80|443))?$/iu.exec(
				authority,
			)?.[1]
		: undefined;
	if (!host) return unsafe_url();

	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return unsafe_url();
	}
	if (url.href.length > 4096 || url.username || url.password)
		return unsafe_url();
	if (host.startsWith('[')) {
		const address = host.slice(1, -1);
		if (isIP(address) !== 6 || !is_public_address(address))
			return unsafe_url();
	} else if (isIP(url.hostname) === 4) {
		// Canonical dotted decimal only, not octal/hex, shortened,
		// integer, percent-encoded, Unicode-mapped or trailing-dot IPs.
		if (host !== url.hostname || !is_public_address(host))
			return unsafe_url();
	} else {
		const name = url.hostname.replace(/\.$/, '');
		const labels = name.split('.');
		if (
			name.length > 253 ||
			labels.length < 2 ||
			labels.some(
				(label) =>
					!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
			) ||
			!/^(?:[a-z]+|xn--[a-z0-9-]+)$/.test(labels.at(-1)!) ||
			// IANA special-use TLDs and conservative local namespaces;
			// example.com/net/org remain usable public DNS fixtures.
			// https://www.iana.org/assignments/special-use-domain-names/
			/(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|corp|arpa|onion|alt|invalid|test|example)$/.test(
				name,
			)
		)
			return unsafe_url();
	}
	return url;
};
