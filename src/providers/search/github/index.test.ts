import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';

const code_mock = vi.fn();
const repos_mock = vi.fn();
const users_mock = vi.fn();

vi.mock('octokit', () => ({
	Octokit: class {
		rest = {
			search: {
				code: code_mock,
				repos: repos_mock,
				users: users_mock,
			},
		};
	},
}));

import { GitHubSearchProvider } from './index.js';

const previous_api_key = config.search.github.api_key;

describe('GitHubSearchProvider response validation', () => {
	beforeEach(() => {
		code_mock.mockReset();
		repos_mock.mockReset();
		users_mock.mockReset();
		config.search.github.api_key = 'github-test-key';
	});

	afterEach(() => {
		config.search.github.api_key = previous_api_key;
		vi.restoreAllMocks();
	});

	it('accepts valid code, repository, and user envelopes', async () => {
		code_mock.mockResolvedValue({
			data: {
				items: [
					{
						name: 'index.ts',
						path: 'src/index.ts',
						html_url:
							'https://github.com/acme/repo/blob/main/src/index.ts',
						score: 1,
						repository: {
							full_name: 'acme/repo',
							html_url: 'https://github.com/acme/repo',
						},
					},
				],
			},
		});
		repos_mock.mockResolvedValue({
			data: {
				items: [
					{
						full_name: 'acme/repo',
						html_url: 'https://github.com/acme/repo',
						description: null,
						stargazers_count: 10,
						forks_count: 2,
						pushed_at: '2026-01-01T00:00:00Z',
						language: null,
						score: 1,
					},
				],
			},
		});
		users_mock.mockResolvedValue({
			data: {
				items: [
					{
						login: 'octocat',
						html_url: 'https://github.com/octocat',
						type: 'User',
						score: 1,
					},
				],
			},
		});

		const provider = new GitHubSearchProvider();
		await expect(
			provider.search_code({ query: 'code' }),
		).resolves.toHaveLength(1);
		await expect(
			provider.search_repositories({ query: 'repo' }),
		).resolves.toHaveLength(1);
		await expect(
			provider.search_users({ query: 'user' }),
		).resolves.toHaveLength(1);
	});

	it.each([
		[
			'code',
			() => new GitHubSearchProvider().search_code({ query: 'code' }),
			code_mock,
		],
		[
			'repositories',
			() =>
				new GitHubSearchProvider().search_repositories({
					query: 'repo',
				}),
			repos_mock,
		],
		[
			'users',
			() =>
				new GitHubSearchProvider().search_users({ query: 'user' }),
			users_mock,
		],
	] as const)(
		'rejects a malformed %s envelope as a provider error',
		async (_name, call, mock) => {
			mock.mockResolvedValue({
				data: { items: { unexpected: true } },
			});

			await expect(call()).rejects.toMatchObject({
				type: 'PROVIDER_ERROR',
				provider: 'github',
				message: 'Malformed github response',
			});
			expect(mock).toHaveBeenCalledTimes(1);
		},
	);
});
