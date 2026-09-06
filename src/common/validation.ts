import { isIP } from 'node:net';
import { ErrorType, ProviderError } from './types.js';

const MAX_PROCESSING_URLS = 20;

const normalize_api_key = (raw: string): string => {
	const trimmed = raw.trim();
	return trimmed.replace(/^(['"])(.*)\1$/, '$2');
};

export const validate_api_key = (
	key: string | undefined,
	provider: string,
): string => {
	if (!key) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			`API key not found for ${provider}`,
			provider,
		);
	}
	return normalize_api_key(key);
};

export const is_api_key_valid = (
	key: string | undefined,
	provider: string,
): boolean => {
	if (!key || key.trim() === '') {
		console.warn(`API key not found or empty for ${provider}`);
		return false;
	}
	return true;
};

const is_non_public_ipv4 = (hostname: string): boolean => {
	const octets = hostname.split('.').map(Number);
	if (
		octets.length !== 4 ||
		octets.some(
			(part) => !Number.isInteger(part) || part < 0 || part > 255,
		)
	) {
		return true;
	}

	const [a, b, c] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 198 &&
			(b === 18 || b === 19 || (b === 51 && c === 100))) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
};

const is_non_public_ipv6 = (hostname: string): boolean => {
	// Only global-unicast literals, excluding special-purpose, documentation,
	// and transition ranges (which can embed otherwise blocked IPv4 targets).
	const [first, second = '0'] = hostname.split(':');
	const prefix = Number.parseInt(first, 16);
	const subnet = Number.parseInt(second || '0', 16);
	return (
		!(prefix >= 0x2000 && prefix <= 0x3fff) ||
		(prefix === 0x2001 && (subnet < 0x200 || subnet === 0xdb8)) ||
		prefix === 0x2002 ||
		(prefix === 0x3fff && subnet < 0x1000)
	);
};

const is_non_public_hostname = (raw_hostname: string): boolean => {
	const hostname = raw_hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
	if (!hostname) return true;

	if (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal') ||
		hostname.endsWith('.home.arpa') ||
		hostname === 'metadata' ||
		hostname === 'instance-data' ||
		hostname === 'instance-data.ec2.internal'
	) {
		return true;
	}

	const ip_version = isIP(hostname);
	if (ip_version === 4) return is_non_public_ipv4(hostname);
	if (ip_version === 6) return is_non_public_ipv6(hostname);

	// Reject single-label hostnames, which are normally local resolver names.
	return !hostname.includes('.');
};

// This is a syntactic public-target policy, not an SSRF guarantee. DNS,
// redirects and crawl-discovered URLs are resolved/fetched by remote providers.
// Local DNS checks would not bind their resolver or prevent rebinding there;
// providers must enforce destination/redirect policy at retrieval time.
export const is_valid_url = (value: string): boolean => {
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:')
			return false;
		if (url.username || url.password) return false;
		return !is_non_public_hostname(url.hostname);
	} catch {
		return false;
	}
};

export const validate_processing_urls = (
	url: string | string[],
	provider_name: string,
): string[] => {
	const urls = Array.isArray(url) ? url : [url];

	if (urls.length === 0) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'At least one URL is required',
			provider_name,
		);
	}
	if (urls.length > MAX_PROCESSING_URLS) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			`A maximum of ${MAX_PROCESSING_URLS} URLs is allowed per request`,
			provider_name,
		);
	}

	for (const candidate of urls) {
		if (!is_valid_url(candidate)) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Invalid URL provided; use a public HTTP(S) URL without credentials',
				provider_name,
			);
		}
	}

	return urls;
};

export const validate_processing_domain = (
	domain: string,
	provider: string,
): string => {
	const hostname = isIP(domain) === 6 ? `[${domain}]` : domain;
	const is_hostname =
		/^[a-z0-9.-]+$/i.test(hostname) ||
		/^\[[a-f0-9:]+\]$/i.test(hostname);
	if (!is_hostname || !is_valid_url(`https://${hostname}`)) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'Invalid public domain provided',
			provider,
		);
	}
	return domain;
};

export const PROCESSING_URL_LIMIT = MAX_PROCESSING_URLS;
