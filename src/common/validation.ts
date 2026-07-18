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
	const normalized = hostname.toLowerCase();
	if (normalized === '::' || normalized === '::1') return true;
	if (normalized.startsWith('fc') || normalized.startsWith('fd'))
		return true;
	if (/^fe[89ab]/.test(normalized)) return true;
	if (normalized.startsWith('2001:db8:')) return true;
	if (normalized.startsWith('::ffff:')) {
		const mapped = normalized.slice('::ffff:'.length);
		return isIP(mapped) === 4 ? is_non_public_ipv4(mapped) : true;
	}
	return false;
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
				`Invalid URL provided: ${candidate}`,
				provider_name,
			);
		}
	}

	return urls;
};

export const PROCESSING_URL_LIMIT = MAX_PROCESSING_URLS;
