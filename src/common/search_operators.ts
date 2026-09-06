export interface SearchOperator {
	type:
		| 'site'
		| 'exclude_site'
		| 'filetype'
		| 'ext'
		| 'intitle'
		| 'inurl'
		| 'inbody'
		| 'inpage'
		| 'language'
		| 'location'
		| 'before'
		| 'after'
		| 'exact'
		| 'force_include'
		| 'exclude_term'
		| 'boolean';
	value: string;
	original_text: string;
	start?: number;
}

export interface ParsedQuery {
	base_query: string;
	operators: SearchOperator[];
	original_query?: string;
}

const operator_patterns = {
	exclude_site: /^-site:([^\s]+)$/,
	site: /^site:([^\s]+)$/,
	filetype: /^filetype:([^\s]+)$/,
	ext: /^ext:([^\s]+)$/,
	intitle: /^intitle:("[^"]+"|[^\s]+)$/,
	inurl: /^inurl:("[^"]+"|[^\s]+)$/,
	inbody: /^inbody:("[^"]+"|[^\s]+)$/,
	inpage: /^inpage:("[^"]+"|[^\s]+)$/,
	language: /^(?:lang|language):([^\s]+)$/,
	location: /^(?:loc|location):([^\s]+)$/,
	before: /^before:(\d{4}(?:-\d{2}(?:-\d{2})?)?)$/,
	after: /^after:(\d{4}(?:-\d{2}(?:-\d{2})?)?)$/,
	exact: /^"([^"]+)"$/,
	force_include: /^\+([^\s]+)$/,
	exclude_term: /^-([^\s:]+)$/,
	boolean: /^(AND|OR|NOT)$/,
};

export const parse_search_operators = (
	query: string,
): ParsedQuery => {
	const operators: SearchOperator[] = [];
	// Match complete tokens, keeping quoted phrases and field values
	// intact. Punctuation inside ordinary words is not syntax.
	const modified_query = query.replace(
		/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g,
		(token, start: number) => {
			for (const [type, pattern] of Object.entries(
				operator_patterns,
			)) {
				const match = pattern.exec(token);
				if (!match) continue;
				operators.push({
					type: type as SearchOperator['type'],
					value: match[1].replace(/^"|"$/g, ''),
					original_text: token,
					start,
				});
				return '';
			}
			return token;
		},
	);

	return {
		base_query: modified_query.replace(/\s+/g, ' ').trim(),
		operators,
		original_query: query,
	};
};

export interface SearchParams {
	query: string;
	parsed_query?: ParsedQuery;
	include_domains?: string[];
	exclude_domains?: string[];
	file_type?: string;
	title_filter?: string;
	url_filter?: string;
	body_filter?: string;
	page_filter?: string;
	language?: string;
	location?: string;
	date_before?: string;
	date_after?: string;
	exact_phrases?: string[];
	force_include_terms?: string[];
	exclude_terms?: string[];
	boolean_operators?: {
		type: 'AND' | 'OR' | 'NOT';
		terms: string[];
	}[];
}

export const apply_search_operators = (
	parsed_query: ParsedQuery,
): SearchParams => {
	const params: SearchParams = {
		query: parsed_query.base_query,
		...(parsed_query.original_query !== undefined
			? { parsed_query }
			: {}),
	};

	for (const operator of parsed_query.operators) {
		switch (operator.type) {
			case 'site':
				params.include_domains = [
					...(params.include_domains || []),
					operator.value,
				];
				break;
			case 'exclude_site':
				params.exclude_domains = [
					...(params.exclude_domains || []),
					operator.value,
				];
				break;
			case 'filetype':
			case 'ext':
				params.file_type = operator.value;
				break;
			case 'intitle':
				params.title_filter = operator.value;
				break;
			case 'inurl':
				params.url_filter = operator.value;
				break;
			case 'inbody':
				params.body_filter = operator.value;
				break;
			case 'inpage':
				params.page_filter = operator.value;
				break;
			case 'language':
				params.language = operator.value;
				break;
			case 'location':
				params.location = operator.value;
				break;
			case 'before':
				params.date_before = operator.value;
				break;
			case 'after':
				params.date_after = operator.value;
				break;
			case 'exact':
				params.exact_phrases = [
					...(params.exact_phrases || []),
					operator.value,
				];
				break;
			case 'force_include':
				params.force_include_terms = [
					...(params.force_include_terms || []),
					operator.value,
				];
				break;
			case 'exclude_term':
				params.exclude_terms = [
					...(params.exclude_terms || []),
					operator.value,
				];
				break;
			case 'boolean':
				if (!params.boolean_operators) {
					params.boolean_operators = [];
				}
				params.boolean_operators.push({
					type: operator.value as 'AND' | 'OR' | 'NOT',
					terms: [],
				});
				break;
		}
	}

	return params;
};

export interface QueryBuildOptions {
	exclude_file_type?: boolean;
	exclude_dates?: boolean;
	exclude_operators?: SearchOperator['type'][];
}

export const build_query_with_operators = (
	search_params: SearchParams,
	additional_include_domains?: string[],
	additional_exclude_domains?: string[],
	options?: QueryBuildOptions,
): string => {
	// Use the source query when available: rebuilding from scalar filters
	// loses repeated fields, Boolean order, grouping, and quoting.
	const parsed = search_params.parsed_query;
	if (parsed?.original_query !== undefined) {
		const excluded = new Set(options?.exclude_operators ?? []);
		if (options?.exclude_file_type) {
			excluded.add('filetype');
			excluded.add('ext');
		}
		if (options?.exclude_dates) {
			excluded.add('before');
			excluded.add('after');
		}
		let query = parsed.original_query;
		for (const operator of [...parsed.operators].reverse()) {
			if (
				operator.start !== undefined &&
				excluded.has(operator.type)
			) {
				query =
					query.slice(0, operator.start) +
					query.slice(operator.start + operator.original_text.length);
			}
		}
		return build_query_with_operators(
			{ query: query.trim() },
			additional_include_domains,
			additional_exclude_domains,
		);
	}
	let query = search_params.query;
	const filters: string[] = [];

	const include_domains = [
		...(additional_include_domains ?? []),
		...(search_params.include_domains ?? []),
	];
	if (include_domains.length) {
		const domain_filter = include_domains
			.map((domain) => `site:${domain}`)
			.join(' OR ');
		filters.push(domain_filter);
	}

	const exclude_domains = [
		...(additional_exclude_domains ?? []),
		...(search_params.exclude_domains ?? []),
	];
	if (exclude_domains.length) {
		filters.push(
			...exclude_domains.map((domain) => `-site:${domain}`),
		);
	}

	if (search_params.file_type && !options?.exclude_file_type) {
		filters.push(`filetype:${search_params.file_type}`);
	}

	if (search_params.title_filter) {
		filters.push(`intitle:${search_params.title_filter}`);
	}

	if (search_params.url_filter) {
		filters.push(`inurl:${search_params.url_filter}`);
	}

	if (search_params.body_filter) {
		filters.push(`inbody:${search_params.body_filter}`);
	}

	if (search_params.page_filter) {
		filters.push(`inpage:${search_params.page_filter}`);
	}

	if (search_params.language) {
		filters.push(`lang:${search_params.language}`);
	}

	if (search_params.location) {
		filters.push(`loc:${search_params.location}`);
	}

	if (search_params.date_before && !options?.exclude_dates) {
		filters.push(`before:${search_params.date_before}`);
	}
	if (search_params.date_after && !options?.exclude_dates) {
		filters.push(`after:${search_params.date_after}`);
	}

	if (search_params.exact_phrases?.length) {
		filters.push(
			...search_params.exact_phrases.map((phrase) => `"${phrase}"`),
		);
	}

	if (search_params.force_include_terms?.length) {
		filters.push(
			...search_params.force_include_terms.map((term) => `+${term}`),
		);
	}

	if (search_params.exclude_terms?.length) {
		filters.push(
			...search_params.exclude_terms.map((term) => `-${term}`),
		);
	}

	if (filters.length > 0) {
		query = `${query} ${filters.join(' ')}`;
	}

	return query.trim();
};
