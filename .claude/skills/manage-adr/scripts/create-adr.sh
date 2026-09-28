#!/usr/bin/env bash
# create-adr.sh — Non-interactive ADR helper around adr-tools.
#
# adr-tools always writes STATUS=Accepted on `adr new`. This wrapper forces
# Proposed at create time and defers Supercedes until `accept`.
#
# Usage:
#   create-adr.sh [--proposes N]... "Title"
#   create-adr.sh accept <number-or-file>
#   create-adr.sh reject <number-or-file>
#
# Do NOT pass adr-tools -s at create time; that immediately unbinds the old ADR.
# Link labels use adr-tools spelling: Supercedes / Superceded by.

set -euo pipefail

export VISUAL=true
export EDITOR=true

if ! command -v adr >/dev/null 2>&1; then
	echo "Error: adr-tools not found (adr). Install adr-tools first." >&2
	exit 1
fi

ADR_PATH="$(command -v adr)"
ADR_BIN="$(dirname "${ADR_PATH}")"

# Marker for Status-only propose targets (never scan Context/Decision prose).
PROPOSE_MARKER_PREFIX='<!-- adr-proposes:'
PROPOSE_MARKER_SUFFIX=' -->'

usage() {
	cat >&2 <<'EOF'
Usage:
  create-adr.sh [--proposes N]... "Title of the ADR"
  create-adr.sh accept <number-or-file>
  create-adr.sh reject <number-or-file>

Notes:
  - New ADRs are rewritten from Accepted to Proposed after adr new.
  - --proposes N requires the target Status to be Accepted; validated before adr new.
  - Status-only markers: <!-- adr-proposes:NNNN-....md --> plus a human Proposes line.
  - accept applies Supercedes via adr link + _adr_remove_status (transactional).
  - Link labels match adr-tools: Supercedes / Superceded by (not English "Supersedes").
EOF
	exit 2
}

adr_dir() {
	# Prefer adr-tools discovery; fall back for docs/adr without .adr-dir yet.
	if [[ -x "${ADR_BIN}/_adr_dir" ]]; then
		local d
		d="$("${ADR_BIN}/_adr_dir" 2>/dev/null || true)"
		if [[ -n ${d} && -d ${d} ]]; then
			echo "${d}"
			return
		fi
	fi
	if [[ -f .adr-dir ]]; then
		cat .adr-dir
	elif [[ -d docs/adr ]]; then
		echo docs/adr
	elif [[ -d doc/adr ]]; then
		echo doc/adr
	else
		echo "Error: ADR directory not found (run: adr init docs/adr)" >&2
		exit 1
	fi
}

resolve_adr_file() {
	local ref="$1"
	if [[ -f ${ref} ]]; then
		echo "${ref}"
		return
	fi
	# adr-tools resolver (number, basename, or partial title)
	if [[ -x "${ADR_BIN}/_adr_file" ]]; then
		local found
		found="$("${ADR_BIN}/_adr_file" "${ref}" 2>/dev/null || true)"
		if [[ -n ${found} && -f ${found} ]]; then
			echo "${found}"
			return
		fi
	fi
	local dir
	dir="$(adr_dir)"
	if [[ -f "${dir}/${ref}" ]]; then
		echo "${dir}/${ref}"
		return
	fi
	# Basename-only link targets from markers
	if [[ -f "${dir}/$(basename "${ref}")" ]]; then
		echo "${dir}/$(basename "${ref}")"
		return
	fi
	echo "Error: could not resolve ADR reference: ${ref}" >&2
	exit 1
}

adr_number() {
	local base
	base="$(basename "$1")"
	echo "$((10#${base%%-*}))"
}

# Normalize Status section first value to a gate token.
normalize_status_token() {
	local line="$1"
	case "${line}" in
	Proposed | Accepted | Rejected | Deprecated | Superseded)
		echo "${line}"
		;;
	Superceded\ by\ * | Superseded\ by\ *)
		echo "Superseded"
		;;
	*)
		# Bullet form: - **Status:** Accepted
		local stripped
		stripped="$(printf '%s\n' "${line}" | sed -E 's/^[[:space:]]*-[[:space:]]*\*\*Status:\*\*[[:space:]]*//; s/^[[:space:]]*\*\*Status:\*\*[[:space:]]*//')"
		case "${stripped}" in
		Proposed | Accepted | Rejected | Deprecated | Superseded)
			echo "${stripped}"
			;;
		Superceded\ by\ * | Superseded\ by\ *)
			echo "Superseded"
			;;
		*)
			echo "${line}"
			;;
		esac
		;;
	esac
}

get_status_line() {
	local file="$1"
	local line=""

	# Bullet Status (e.g. python docs/adr/0001, template.md)
	line="$(sed -nE 's/^-[[:space:]]*\*\*Status:\*\*[[:space:]]*(.*)$/\1/p' "${file}" | head -n1)"

	if [[ -z ${line} ]]; then
		if [[ -x "${ADR_BIN}/_adr_status" ]]; then
			line="$("${ADR_BIN}/_adr_status" "${file}" | awk 'NF { print; exit }')"
		else
			line="$(awk '
				BEGIN { in_status=0 }
				/^## Status$/ { in_status=1; next }
				in_status && NF { print; exit }
			' "${file}")"
		fi
	fi

	normalize_status_token "${line}"
}

require_status() {
	local file="$1"
	local want="$2"
	local action="$3"
	local status
	status="$(get_status_line "${file}")"
	if [[ ${status} != "${want}" ]]; then
		echo "Error: ${action} requires Status ${want} (found: ${status}) in ${file}" >&2
		exit 1
	fi
}

require_proposed() {
	require_status "$1" "Proposed" "$2"
}

require_accepted() {
	require_status "$1" "Accepted" "$2"
}

# Rewrite Status in either ## Status body line or - **Status:** bullet.
# Fails if no replacement occurred.
set_status() {
	local file="$1"
	local new_status="$2"
	local tmp
	tmp="$(mktemp)"
	awk -v ns="${new_status}" '
		BEGIN { replaced=0; in_status=0 }
		/^-[[:space:]]*\*\*Status:\*\*/ {
			print "- **Status:** " ns
			replaced=1
			next
		}
		/^## Status$/ {
			in_status=1
			print
			next
		}
		in_status && !replaced && NF {
			print ns
			replaced=1
			in_status=0
			next
		}
		{ print }
		END {
			if (!replaced) {
				print "Error: set_status: no Status field found to replace" > "/dev/stderr"
				exit 1
			}
		}
	' "${file}" >"${tmp}"
	mv "${tmp}" "${file}"
}

# Append Status-only markers + human Proposes lines after the status value.
# Args after file are already-resolved ADR file paths.
append_proposes_markers() {
	local file="$1"
	shift
	[[ $# -eq 0 ]] && return

	local tmp line in_status=0 status_seen=0 target_file target_base
	tmp="$(mktemp)"
	{
		while IFS= read -r line || [[ -n ${line} ]]; do
			if [[ ${line} =~ ^-[[:space:]]*\*\*Status:\*\* ]]; then
				printf '%s\n' "${line}"
				status_seen=1
				for target_file in "$@"; do
					target_base="$(basename "${target_file}")"
					printf '\n%s%s%s\n' "${PROPOSE_MARKER_PREFIX}" "${target_base}" "${PROPOSE_MARKER_SUFFIX}"
					printf 'Proposes to supersede [%s](%s)\n' "${target_base%.md}" "${target_base}"
				done
				continue
			fi
			if [[ ${line} == "## Status" ]]; then
				in_status=1
				printf '%s\n' "${line}"
				continue
			fi
			if [[ ${in_status} -eq 1 && ${status_seen} -eq 0 && -n ${line} ]]; then
				printf '%s\n' "${line}"
				status_seen=1
				in_status=0
				for target_file in "$@"; do
					target_base="$(basename "${target_file}")"
					printf '\n%s%s%s\n' "${PROPOSE_MARKER_PREFIX}" "${target_base}" "${PROPOSE_MARKER_SUFFIX}"
					printf 'Proposes to supersede [%s](%s)\n' "${target_base%.md}" "${target_base}"
				done
				continue
			fi
			printf '%s\n' "${line}"
		done <"${file}"
	} >"${tmp}"
	mv "${tmp}" "${file}"
}

# Extract propose targets from Status markers only.
extract_propose_targets() {
	sed -nE "s/^<!-- adr-proposes:([^ ]+) -->$/\1/p" "$1"
}

strip_propose_markers() {
	local file="$1"
	local tmp
	tmp="$(mktemp)"
	awk '
		/^<!-- adr-proposes:/ { next }
		/^Proposes to supersede / { next }
		{ print }
	' "${file}" >"${tmp}"
	mv "${tmp}" "${file}"
}

cmd_create() {
	local proposes=()
	local title_parts=()

	while [[ $# -gt 0 ]]; do
		case "$1" in
		--proposes)
			shift
			[[ $# -gt 0 ]] || usage
			proposes+=("$1")
			shift
			;;
		-s | --supercedes | --supersedes)
			echo "Error: do not use -s/--supercedes at create time; use --proposes N then 'accept'." >&2
			exit 1
			;;
		-h | --help)
			usage
			;;
		*)
			title_parts+=("$1")
			shift
			;;
		esac
	done

	[[ ${#title_parts[@]} -gt 0 ]] || usage

	local resolved=()
	local path
	if [[ ${#proposes[@]} -gt 0 ]]; then
		for path in "${proposes[@]}"; do
			path="$(resolve_adr_file "${path}")"
			require_accepted "${path}" "challenge/propose"
			resolved+=("${path}")
		done
	fi

	local created
	if ! created="$(adr new "${title_parts[*]}")"; then
		echo "Error: Failed to create ADR." >&2
		exit 1
	fi

	created="${created%%$'\n'*}"
	created="${created//$'\r'/}"
	if [[ ! -f ${created} ]]; then
		created="$(resolve_adr_file "${created}")"
	fi

	set_status "${created}" "Proposed"

	if [[ ${#resolved[@]} -gt 0 ]]; then
		append_proposes_markers "${created}" "${resolved[@]}"
	fi

	echo "${created}"
}

apply_supercedes() {
	local new_file="$1"
	local old_ref="$2"
	local new_num old_file old_num
	new_num="$(adr_number "${new_file}")"
	old_file="$(resolve_adr_file "${old_ref}")"
	old_num="$(adr_number "${old_file}")"

	# Same effect as adr-tools `adr new -s`, deferred until Accept.
	# Labels match adr-tools spelling (Supercedes / Superceded by).
	adr link "${new_num}" Supercedes "${old_num}" "Superceded by"
	if [[ -x "${ADR_BIN}/_adr_remove_status" ]]; then
		"${ADR_BIN}/_adr_remove_status" Accepted "${old_num}"
	fi
}

refresh_toc() {
	local dir index tmp
	dir="$(adr_dir)"
	if [[ -f "${dir}/README.md" ]]; then
		index="${dir}/README.md"
	elif [[ -f "${dir}/index.md" ]]; then
		index="${dir}/index.md"
	else
		return 0
	fi
	tmp="$(mktemp)"
	if adr generate toc >"${tmp}"; then
		mv "${tmp}" "${index}"
	else
		rm -f "${tmp}"
		echo "Warning: adr generate toc failed; index may be stale." >&2
	fi
}

cmd_accept() {
	[[ $# -eq 1 ]] || usage
	local file target
	file="$(resolve_adr_file "$1")"
	require_proposed "${file}" "accept"

	local targets=()
	local propose_list
	propose_list="$(extract_propose_targets "${file}")"
	while IFS= read -r target; do
		[[ -z ${target} ]] && continue
		targets+=("${target}")
	done <<<"${propose_list}"

	# Preflight: each propose target still resolves and is still Accepted.
	local resolved_targets=()
	local path
	for target in "${targets[@]}"; do
		path="$(resolve_adr_file "${target}")"
		require_accepted "${path}" "accept (propose target)"
		resolved_targets+=("${path}")
	done

	# Transactional accept: backup all touched files; restore on any failure.
	local backup_dir adr_parent
	backup_dir="$(mktemp -d)"
	adr_parent="$(cd "$(dirname "${file}")" && pwd)"

	_accept_rollback() {
		local status=$?
		trap - ERR EXIT
		if [[ ${status} -ne 0 && -d ${backup_dir} ]]; then
			local f base
			for f in "${backup_dir}"/*; do
				[[ -f ${f} ]] || continue
				base="$(basename "${f}")"
				cp -f "${f}" "${adr_parent}/${base}"
			done
			echo "Error: accept failed; restored ADR backups" >&2
		fi
		rm -rf "${backup_dir}"
		exit "${status}"
	}
	trap _accept_rollback ERR EXIT

	cp -f "${file}" "${backup_dir}/$(basename "${file}")"
	for path in "${resolved_targets[@]}"; do
		cp -f "${path}" "${backup_dir}/$(basename "${path}")"
	done

	# Prefer link/supersede while still Proposed, then flip to Accepted.
	for path in "${resolved_targets[@]}"; do
		apply_supercedes "${file}" "${path}"
	done

	set_status "${file}" "Accepted"
	strip_propose_markers "${file}"
	refresh_toc

	trap - ERR EXIT
	rm -rf "${backup_dir}"

	echo "${file}"
}

cmd_reject() {
	[[ $# -eq 1 ]] || usage
	local file
	file="$(resolve_adr_file "$1")"
	require_proposed "${file}" "reject"
	set_status "${file}" "Rejected"
	echo "${file}"
}

main() {
	[[ $# -gt 0 ]] || usage
	case "$1" in
	accept)
		shift
		cmd_accept "$@"
		;;
	reject)
		shift
		cmd_reject "$@"
		;;
	-h | --help)
		usage
		;;
	*)
		cmd_create "$@"
		;;
	esac
}

main "$@"
