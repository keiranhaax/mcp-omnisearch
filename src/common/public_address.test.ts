import { describe, expect, it } from 'vitest';
import {
	is_public_address,
	parse_public_url,
} from './public_address.js';
import { ErrorType, ProviderError } from './types.js';

const invalid_message =
	'Invalid URL provided; use a public HTTP(S) URL without credentials';

const expect_unsafe = (input: string): void => {
	let caught: unknown;
	try {
		parse_public_url(input);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ProviderError);
	expect(caught).toMatchObject({
		type: ErrorType.INVALID_INPUT,
		provider: 'defuddle',
		message: invalid_message,
		details: { retryable: false, cause: 'unsafe_url' },
	});
	if (caught instanceof ProviderError) {
		expect(caught.details).toEqual({
			retryable: false,
			cause: 'unsafe_url',
		});
		expect(caught.cause).toBeUndefined();
	}
};

// First/last addresses of reviewed exclusion ranges, not live hosts.
const blocked_ipv4 = [
	['0.0.0.0', '0.255.255.255'],
	['10.0.0.0', '10.255.255.255'],
	['100.64.0.0', '100.127.255.255'],
	['127.0.0.0', '127.255.255.255'],
	['169.254.0.0', '169.254.255.255'],
	['172.16.0.0', '172.31.255.255'],
	['192.0.0.0', '192.0.0.255'],
	['192.0.2.0', '192.0.2.255'],
	['192.31.196.0', '192.31.196.255'],
	['192.52.193.0', '192.52.193.255'],
	['192.88.99.0', '192.88.99.255'],
	['192.168.0.0', '192.168.255.255'],
	['192.175.48.0', '192.175.48.255'],
	['198.18.0.0', '198.19.255.255'],
	['198.51.100.0', '198.51.100.255'],
	['203.0.113.0', '203.0.113.255'],
	['224.0.0.0', '239.255.255.255'],
	['240.0.0.0', '255.255.255.255'],
].flat();

const public_ipv4_edges = [
	'1.0.0.0',
	'9.255.255.255',
	'11.0.0.0',
	'100.63.255.255',
	'100.128.0.0',
	'126.255.255.255',
	'128.0.0.0',
	'168.63.129.15',
	'168.63.129.17',
	'169.253.255.255',
	'169.255.0.0',
	'172.15.255.255',
	'172.32.0.0',
	'191.255.255.255',
	'192.0.1.0',
	'192.0.1.255',
	'192.0.3.0',
	'192.31.195.255',
	'192.31.197.0',
	'192.52.192.255',
	'192.52.194.0',
	'192.88.98.255',
	'192.88.100.0',
	'192.167.255.255',
	'192.169.0.0',
	'192.175.47.255',
	'192.175.49.0',
	'198.17.255.255',
	'198.20.0.0',
	'198.51.99.255',
	'198.51.101.0',
	'203.0.112.255',
	'203.0.114.0',
	'223.255.255.255',
];

const blocked_ipv6 = [
	'::',
	'::1',
	'::ffff:0:0',
	'::ffff:ffff:ffff',
	'::ffff:8.8.8.8',
	'::ffff:127.0.0.1',
	'0:0:0:0:0:ffff:7f00:1',
	'::127.0.0.1',
	'::8.8.8.8',
	'::ffff:0:8.8.8.8',
	'64:ff9b::',
	'64:ff9b::ffff:ffff',
	'64:ff9b::8.8.8.8',
	'64:ff9b::169.254.169.254',
	'64:ff9b:1::',
	'64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
	'100::',
	'100::ffff:ffff:ffff:ffff',
	'100:0:0:1::',
	'100:0:0:1:ffff:ffff:ffff:ffff',
	'1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2000::',
	'2001::',
	'2001:1::1',
	'2001:1::2',
	'2001:1::3',
	'2001:2::1',
	'2001:3::1',
	'2001:4:112::1',
	'2001:10::1',
	'2001:20::1',
	'2001:30::1',
	'2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:db8::',
	'2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:1000::',
	'2001:11ff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:4e00::',
	'2001:4fff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:6000::',
	'2001:7fff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:c000::',
	'2002::',
	'2002:0808:0808::',
	'2002:7f00:1::',
	'2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2003:4000::',
	'2420::',
	'2610:200::',
	'2620:4f:8000::',
	'2620:4f:8000:ffff:ffff:ffff:ffff:ffff',
	'2620:200::',
	'2640::',
	'2a20::',
	'2c10::',
	'2d00::',
	'3ffe::',
	'3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'3fff::',
	'3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff',
	'3fff:1000::',
	'3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'4000::',
	'5f00::',
	'fc00::',
	'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'fe80::',
	'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'fec0::',
	'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'ff00::',
	'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:4860::5efe:127.0.0.1',
	'2001:4860:0:0:0:5efe:7f00:1',
	'2001:4860::200:5efe:8.8.8.8',
	'2001:4860:0:0:0200:5EFE:0808:0808',
];

const public_ipv6 = [
	'2001:200::',
	'2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:db9::',
	'2001:fff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:1200::',
	'2001:4dff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:5000::',
	'2001:5fff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:8000::',
	'2001:bfff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2003::',
	'2003:3fff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2400::',
	'2410::',
	'2410:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'241f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2600::',
	'260f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2610::',
	'2610:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2620::',
	'2620:4f:7fff:ffff:ffff:ffff:ffff:ffff',
	'2620:4f:8001::',
	'2620:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2630::',
	'263f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2800::',
	'2a00::',
	'2a10::',
	'2a1f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2c00::',
	'2c0f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
	'2001:4860:4860::8888',
	'2606:4700:4700::1111',
	'2001:4860:4860:0000:0000:0000:0000:8888',
	'2001:4860::8.8.8.8',
	'2001:4860::201:5efe:808:808',
	'2001:4860::200:5eff:808:808',
];

const numeric_hosts = [
	'2130706433',
	'134744072',
	'4294967295',
	'4294967296',
	'0x7f000001',
	'0x08080808',
	'017700000001',
	'010.010.010.010',
	'008.008.008.008',
	'0x8.0x8.0x8.0x8',
	'127.1',
	'127.0.1',
	'8.8.2056',
	'8.526344',
	'8.8.8.8.',
	'127.0.0.1.',
	'256.1.1.1',
	'1.2.3.4.5',
	'1.2.3.-1',
	'1.2.3.1e2',
	'0xgg.1.1.1',
	'1e2.1e2.1e2.1e2',
	'１.１.１.１',
	'１２７.０.０.１',
	'%38.8.8.8',
	'8%2e8%2e8%2e8',
];

describe('is_public_address', () => {
	it.each(blocked_ipv4)('rejects IPv4 CIDR edge %s', (address) => {
		expect(is_public_address(address)).toBe(false);
	});

	it.each(public_ipv4_edges)(
		'accepts IPv4 immediately outside exclusions: %s',
		(address) => expect(is_public_address(address)).toBe(true),
	);

	it.each([
		'169.254.169.254',
		'169.254.170.2',
		'100.100.100.200',
		'168.63.129.16',
		'192.0.0.9',
		'192.0.0.10',
		'192.0.0.170',
		'192.0.0.171',
		'192.88.99.2',
	])('rejects metadata and special-purpose address %s', (address) => {
		expect(is_public_address(address)).toBe(false);
		expect_unsafe(`https://${address}/`);
	});

	it.each(blocked_ipv6)('rejects non-public IPv6 %s', (address) => {
		expect(is_public_address(address)).toBe(false);
		expect(is_public_address(address.toUpperCase())).toBe(false);
		const canonical = new URL(`https://[${address}]/`).hostname.slice(
			1,
			-1,
		);
		expect(is_public_address(canonical)).toBe(false);
	});

	it.each(public_ipv6)(
		'accepts global unicast IPv6 %s',
		(address) => {
			expect(is_public_address(address)).toBe(true);
			expect(is_public_address(address.toUpperCase())).toBe(true);
		},
	);

	it.each([
		...numeric_hosts,
		'',
		'example.com',
		'8.8.8.8/32',
		'8.8.8.8:80',
		' 8.8.8.8',
		'8.8.8.8\n',
		'[2606:4700:4700::1111]',
		'2606:4700:4700::1111%eth0',
		'2606:4700:4700::1111%25eth0',
		'2606:4700:4700::1111/128',
		'2001:::1',
		'2001::1::1',
		'2001:4860::gggg',
		'2001:4860::256.0.0.1',
		'2001:4860::010.0.0.1',
		'8.8.8.8,1.1.1.1',
		'8.8.8.8,127.0.0.1',
	])('rejects nonliteral or malformed address %s', (address) => {
		expect(is_public_address(address)).toBe(false);
	});
});

describe('parse_public_url', () => {
	it.each([
		[
			'https://EXAMPLE.com:443/a/../b?q=1#top',
			'https://example.com/b?q=1#top',
		],
		['HTTP://Example.com:80', 'http://example.com/'],
		['https://example.com:80/', 'https://example.com:80/'],
		['http://example.com:443/', 'http://example.com:443/'],
		['https://8.8.8.8/', 'https://8.8.8.8/'],
		[
			'https://[2001:4860:4860:0:0:0:0:8888]:443/',
			'https://[2001:4860:4860::8888]/',
		],
		[
			'https://[2001:4860::8.8.8.8]/',
			'https://[2001:4860::808:808]/',
		],
		['https://bücher.de/ü', 'https://xn--bcher-kva.de/%C3%BC'],
		['https://xn--bcher-kva.de/', 'https://xn--bcher-kva.de/'],
		['https://sub.example.com./', 'https://sub.example.com./'],
		['https://1.2.example.com/', 'https://1.2.example.com/'],
		[
			'https://example.com/@user?a=https://localhost#@x',
			'https://example.com/@user?a=https://localhost#@x',
		],
		['https://example.com/a%20b', 'https://example.com/a%20b'],
	])('normalizes public URL %s', (input, expected) => {
		const result = parse_public_url(input);
		expect(result).toBeInstanceOf(URL);
		expect(result.href).toBe(expected);
	});

	it.each([...blocked_ipv4, ...numeric_hosts])(
		'rejects unsafe IPv4 authority %s',
		(host) => expect_unsafe(`http://${host}/secret?q=token`),
	);

	it.each(blocked_ipv6)(
		'rejects unsafe IPv6 authority %s',
		(host) => {
			expect_unsafe(`https://[${host}]/`);
		},
	);

	it.each(public_ipv4_edges)(
		'accepts public IPv4 authority %s',
		(host) => {
			expect(parse_public_url(`https://${host}/`).hostname).toBe(
				host,
			);
		},
	);

	it.each(public_ipv6)('accepts public IPv6 authority %s', (host) => {
		const result = parse_public_url(`https://[${host}]/`);
		expect(parse_public_url(result.href).href).toBe(result.href);
	});

	it.each([
		'localhost',
		'LOCALHOST.',
		'sub.localhost',
		'local',
		'service.local',
		'service.localdomain',
		'printer.lan',
		'router.home',
		'router.corp',
		'service.internal',
		'home.arpa',
		'router.home.arpa.',
		'1.0.0.127.in-addr.arpa',
		'ipv4only.arpa',
		'name.onion',
		'name.alt',
		'name.invalid',
		'name.test',
		'name.example',
		'metadata',
		'instance-data',
		'instance-data.ec2.internal',
		'metadata.google.internal',
		'ｌｏｃａｌｈｏｓｔ',
		'example.com.localhost',
	])('rejects local/special-use name %s', (host) => {
		expect_unsafe(`https://${host}/`);
	});

	it.each([
		'localhost.example.com',
		'notlocalhost.com',
		'metadata.example.com',
		'example.com',
		'example.net',
		'example.org',
		'public-domain.example.com',
	])('does not overmatch public domain %s', (host) => {
		expect(parse_public_url(`https://${host}`).hostname).toBe(host);
	});

	it.each([
		'https://user:password@example.com/private?token=SECRET',
		'https://user@example.com',
		'https://:password@example.com',
		'https://@example.com',
		'https://:@example.com',
		'https://user@@example.com',
		'https://%40example.com',
		'https://example.com%2f@8.8.8.8',
		'https://example.com%40localhost',
		'https://%65xample.com/',
		'https://example.com%00.attacker.com/',
		'https://[::1%25eth0]/',
		'https://[2606:4700:4700::1111%eth0]/',
		'https://[2606:4700:4700::1111%25eth0]/',
	])('rejects credentials and authority encoding: %s', expect_unsafe);

	it.each([
		'',
		'example.com',
		'//example.com/',
		'http:example.com',
		'http:/example.com',
		'http:///example.com',
		'https:////example.com',
		'https://',
		'https://?example.com',
		'https://#example.com',
		'file://example.com/file',
		'ftp://example.com/',
		'javascript:alert(1)',
		'data:text/plain,SECRET',
		'https://example.com:0/',
		'https://example.com:8080/',
		'https://example.com:8443/',
		'https://example.com:65536/',
		'https://example.com:/',
		'https://example.com:080/',
		'https://example.com:0443/',
		'https://example.com:+80/',
		'https://example.com:80:443/',
		'https://[2606:4700:4700::1111]:8080/',
		'https://[2606:4700:4700::1111]:/',
		'https://8.8.8.8:8080/',
		'https://8.8.8.8:/',
		'https://2606:4700:4700::1111/',
		'https://[8.8.8.8]/',
		'https://[2001:::1]/',
		'https://[2001:4860::1/',
		'https://[2001:4860::1]example.com/',
		'https://[]/',
		'https://example.com,other.com/',
		'https://example.com|other.com/',
		'https://.example.com/',
		'https://example..com/',
		'https://example.com../',
		'https://-example.com/',
		'https://example-.com/',
		'https://_service.example.com/',
		'https://example.123/',
		'https://example.0x123/',
		'https://example.1e2/',
		'https://xn--.com/',
		'https://example。com/',
		'https://example．com/',
		'https://example｡com/',
		'https://exam\u200bple.com/',
		'https://example.com/invalid%escape',
		'https://example.com/%',
	])(
		'rejects malformed URL/host or disallowed port: %s',
		expect_unsafe,
	);

	it('rejects controls, raw whitespace, and backslashes anywhere', () => {
		const characters = [
			...Array.from({ length: 33 }, (_, i) => String.fromCharCode(i)),
			...Array.from({ length: 33 }, (_, i) =>
				String.fromCharCode(127 + i),
			),
			'\u00a0',
			'\u1680',
			'\u2000',
			'\u2028',
			'\u2029',
			'\u202f',
			'\u205f',
			'\u3000',
			'\ufeff',
			'\\',
		];
		for (const character of characters) {
			expect_unsafe(`${character}https://example.com/`);
			expect_unsafe(`https://exa${character}mple.com/`);
			expect_unsafe(`https://example.com/a${character}b`);
			expect_unsafe(`https://example.com/?q=${character}`);
			expect_unsafe(`https://example.com/#${character}`);
		}
		expect_unsafe('https://example.com\\@127.0.0.1/');
	});

	it('bounds raw and normalized URL lengths', () => {
		const prefix = 'https://example.com/';
		const maximum = prefix + 'a'.repeat(4096 - prefix.length);
		expect(parse_public_url(maximum).href).toBe(maximum);
		expect_unsafe(`${maximum}a`);
		expect_unsafe(prefix + 'ü'.repeat(1000));
	});

	it('enforces DNS label and full hostname limits', () => {
		const maximum = [63, 63, 63, 61]
			.map((n) => 'a'.repeat(n))
			.join('.');
		expect(parse_public_url(`https://${maximum}/`).hostname).toBe(
			maximum,
		);
		expect(parse_public_url(`https://${maximum}./`).hostname).toBe(
			`${maximum}.`,
		);
		expect_unsafe(`https://${maximum}a/`);
		expect_unsafe(`https://${'a'.repeat(64)}.com/`);
	});

	it('fails closed on nonstring values at the untrusted boundary', () => {
		for (const value of [
			null,
			undefined,
			1,
			{},
			['https://example.com'],
		]) {
			expect_unsafe(value as unknown as string);
			expect(is_public_address(value as unknown as string)).toBe(
				false,
			);
		}
	});

	it('never attaches rejected input or URL-parser errors', () => {
		try {
			parse_public_url(
				'https://SECRET:SECRET@localhost/SECRET?SECRET',
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderError);
			expect(JSON.stringify(error)).not.toContain('SECRET');
			expect(String(error)).toBe(`ProviderError: ${invalid_message}`);
			expect(Object.keys(error as Error).sort()).toEqual([
				'details',
				'name',
				'provider',
				'type',
			]);
			return;
		}
		expect.fail('Expected URL rejection');
	});
});
