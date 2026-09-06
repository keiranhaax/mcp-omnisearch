import { describe, expect, it, vi } from 'vitest';
import { ErrorType } from './types.js';
import {
	is_api_key_valid,
	is_valid_url,
	validate_api_key,
	validate_processing_urls,
} from './validation.js';

describe('validate_api_key', () => {
	it('trims whitespace and strips surrounding quotes', () => {
		expect(validate_api_key('  "secret-key"  ', 'tavily')).toBe(
			'secret-key',
		);
	});

	it('throws a provider error when the key is missing', () => {
		expect(() => validate_api_key(undefined, 'brave')).toThrowError(
			expect.objectContaining({
				type: ErrorType.INVALID_INPUT,
				provider: 'brave',
				message: 'API key not found for brave',
			}),
		);
	});
});

describe('is_api_key_valid', () => {
	it('returns true for a non-empty key', () => {
		expect(is_api_key_valid('abc123', 'exa')).toBe(true);
	});

	it('warns and returns false for an empty key', () => {
		const warn = vi
			.spyOn(console, 'warn')
			.mockImplementation(() => {});

		expect(is_api_key_valid('   ', 'exa')).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			'API key not found or empty for exa',
		);
	});
});

describe('is_valid_url', () => {
	it('accepts public HTTP and HTTPS URLs', () => {
		expect(is_valid_url('https://example.com/path?q=1')).toBe(true);
		expect(is_valid_url('http://docs.example.com')).toBe(true);
	});

	it('rejects non-public IPv6 ranges including multicast and site-local', () => {
		for (const host of [
			'ff02::1',
			'fec0::1',
			'fe80::1234',
			'::ffff:7f00:1',
			'64:ff9b::a00:1',
			'100::1',
			'2001::1',
			'2002:a00:1::',
			'3fff::1',
		]) {
			expect(is_valid_url(`https://[${host}]`), host).toBe(false);
		}
		for (const host of [
			'2001:4860:4860::8888',
			'2606:4700:4700::1111',
		]) {
			expect(is_valid_url(`https://[${host}]`), host).toBe(true);
		}
	});

	it('rejects malformed, non-HTTP, and credential-bearing URLs', () => {
		expect(is_valid_url('not-a-url')).toBe(false);
		expect(is_valid_url('file:///etc/passwd')).toBe(false);
		expect(is_valid_url('ftp://example.com/file')).toBe(false);
		expect(is_valid_url('https://user:pass@example.com')).toBe(false);
	});

	it('rejects local, private, link-local, and metadata targets', () => {
		for (const url of [
			'http://localhost:3000',
			'http://service.local/path',
			'http://127.0.0.1',
			'http://10.0.0.4',
			'http://172.16.0.1',
			'http://192.168.1.1',
			'http://100.84.79.102',
			'http://169.254.169.254/latest/meta-data',
			'http://[::1]',
			'http://[fd00::1]',
			'http://metadata.google.internal',
		]) {
			expect(is_valid_url(url), url).toBe(false);
		}
	});
});

describe('validate_processing_urls', () => {
	it('normalizes a single URL into an array', () => {
		expect(
			validate_processing_urls('https://example.com', 'firecrawl'),
		).toEqual(['https://example.com']);
	});

	it('returns an array unchanged when all URLs are valid', () => {
		expect(
			validate_processing_urls(
				['https://example.com', 'https://kit.svelte.dev'],
				'firecrawl',
			),
		).toEqual(['https://example.com', 'https://kit.svelte.dev']);
	});

	it.each([
		'file:///private/SECRET',
		'data:text/plain,SECRET',
		'https://localhost/path\nSECRET',
	])('does not echo rejected URL input: %s', (value) => {
		expect(() =>
			validate_processing_urls(value, 'fixture'),
		).toThrowError(
			'Invalid URL provided; use a public HTTP(S) URL without credentials',
		);
	});

	it('throws a provider error for invalid URLs', () => {
		expect(() =>
			validate_processing_urls(
				['https://example.com', 'nope'],
				'firecrawl',
			),
		).toThrowError(
			expect.objectContaining({
				type: ErrorType.INVALID_INPUT,
				provider: 'firecrawl',
				message:
					'Invalid URL provided; use a public HTTP(S) URL without credentials',
			}),
		);
	});

	it('caps multi-URL requests to prevent unbounded paid fan-out', () => {
		const urls = Array.from(
			{ length: 21 },
			(_, index) => `https://example.com/${index}`,
		);
		expect(() =>
			validate_processing_urls(urls, 'firecrawl'),
		).toThrowError(
			expect.objectContaining({
				type: ErrorType.INVALID_INPUT,
				message: 'A maximum of 20 URLs is allowed per request',
			}),
		);
	});
});
