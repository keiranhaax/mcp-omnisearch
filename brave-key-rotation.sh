#!/usr/bin/env bash
set -euo pipefail

TMP_ROOT="${TMPDIR:-/tmp}"

load_key_pool() {
	local target_var="$1"
	local pool_env_var="$2"
	local pool_file_var="$3"
	local pool_value="${!pool_env_var:-}"
	local pool_file="${!pool_file_var:-}"

	if [[ -n "$pool_value" ]]; then
		printf '%s\n' "$pool_value" |
			tr ',' '\n' |
			sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
			sed '/^$/d'
		return 0
	fi

	if [[ -n "$pool_file" && -f "$pool_file" ]]; then
		sed 's/^[[:space:]]*//; s/[[:space:]]*$//' "$pool_file" |
			sed '/^$/d'
		return 0
	fi

	if [[ -n "${!target_var:-}" ]]; then
		printf '%s\n' "${!target_var}"
	fi
}

rotate_key() {
	local target_var="$1"
	local pool_env_var="$2"
	local pool_file_var="$3"
	local lockfile="${TMP_ROOT}/${target_var,,}.lock"
	local indexfile="${TMP_ROOT}/${target_var,,}.index"
	local -a keys=()

	mapfile -t keys < <(
		load_key_pool "$target_var" "$pool_env_var" "$pool_file_var"
	)

	if [[ ${#keys[@]} -eq 0 ]]; then
		return 0
	fi

	exec 200>"$lockfile"
	flock -x 200

	if [[ ! -f "$indexfile" ]]; then
		echo 0 > "$indexfile"
	fi

	local index
	index="$(<"$indexfile")"
	if [[ ! "$index" =~ ^[0-9]+$ ]]; then
		index=0
	fi

	local selected_key="${keys[$((index % ${#keys[@]}))]}"
	local next_index=$(( (index + 1) % ${#keys[@]} ))
	echo "$next_index" > "$indexfile"

	flock -u 200

	export "${target_var}=${selected_key}"
}

rotate_key BRAVE_API_KEY BRAVE_API_KEYS BRAVE_API_KEYS_FILE
rotate_key \
	BRAVE_SEARCH_API_KEY \
	BRAVE_SEARCH_API_KEYS \
	BRAVE_SEARCH_API_KEYS_FILE
