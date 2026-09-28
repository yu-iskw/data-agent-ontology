#!/usr/bin/env bash
# test-create-adr.sh — Portable regression harness for create-adr.sh
#
# Stubs adr / _adr_* on PATH. Does not require real adr-tools.
# Exit 0 on success.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE_ADR="${ROOT}/create-adr.sh"
[[ -x ${CREATE_ADR} || -f ${CREATE_ADR} ]] || {
	echo "missing create-adr.sh next to this test" >&2
	exit 1
}
chmod +x "${CREATE_ADR}" 2>/dev/null || true

FAILS=0
assert_eq() {
	local name="$1" want="$2" got="$3"
	if [[ ${want} == "${got}" ]]; then
		echo "ok - ${name}"
	else
		echo "not ok - ${name}: want=$(printf %q "${want}") got=$(printf %q "${got}")" >&2
		FAILS=$((FAILS + 1))
	fi
}

assert_file_contains() {
	local name="$1" needle="$2" file="$3"
	if grep -qF -- "${needle}" "${file}"; then
		echo "ok - ${name}"
	else
		echo "not ok - ${name}: ${file} missing $(printf %q "${needle}")" >&2
		FAILS=$((FAILS + 1))
	fi
}

assert_exit() {
	local name="$1" want="$2"
	shift 2
	local got=0
	"$@" >/dev/null 2>&1 || got=$?
	assert_eq "${name}" "${want}" "${got}"
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
STUB="${WORKDIR}/stubbin"
ADR_HOME="${WORKDIR}/adrhome"
mkdir -p "${STUB}" "${ADR_HOME}/docs/adr"
cd "${ADR_HOME}"

# --- stub adr-tools ---
cat >"${STUB}/_adr_dir" <<'EOF'
#!/usr/bin/env bash
echo "${ADR_TEST_DIR:-docs/adr}"
EOF

cat >"${STUB}/_adr_file" <<'EOF'
#!/usr/bin/env bash
ref="$1"
dir="${ADR_TEST_DIR:-docs/adr}"
if [[ -f ${ref} ]]; then
	echo "${ref}"
	exit 0
fi
if [[ ${ref} =~ ^[0-9]+$ ]]; then
	n=$(printf '%04d' "$((10#${ref}))")
	match=( "${dir}"/${n}-*.md )
	if [[ -f ${match[0]} ]]; then
		echo "${match[0]}"
		exit 0
	fi
fi
if [[ -f "${dir}/${ref}" ]]; then
	echo "${dir}/${ref}"
	exit 0
fi
base="$(basename "${ref}")"
if [[ -f "${dir}/${base}" ]]; then
	echo "${dir}/${base}"
	exit 0
fi
exit 1
EOF

cat >"${STUB}/_adr_status" <<'EOF'
#!/usr/bin/env bash
file="$1"
# Prefer bullet
line="$(sed -nE 's/^-[[:space:]]*\*\*Status:\*\*[[:space:]]*(.*)$/\1/p' "${file}" | head -n1)"
if [[ -n ${line} ]]; then
	echo "${line}"
	exit 0
fi
awk 'BEGIN{s=0} /^## Status$/{s=1;next} s&&NF{print;exit}' "${file}"
EOF

cat >"${STUB}/_adr_remove_status" <<'EOF'
#!/usr/bin/env bash
# _adr_remove_status Accepted <num> — strip Accepted status line (adr-tools-like)
want="$1"
num="$2"
dir="${ADR_TEST_DIR:-docs/adr}"
n=$(printf '%04d' "$((10#${num}))")
match=( "${dir}"/${n}-*.md )
file="${match[0]}"
[[ -f ${file} ]] || exit 1
tmp="$(mktemp)"
awk -v w="${want}" '
	BEGIN{in_status=0}
	/^-[[:space:]]*\*\*Status:\*\*/ {
		# leave bullet but clear Accepted token later via link stub; skip removing whole line
		print
		next
	}
	/^## Status$/{in_status=1;print;next}
	in_status && $0==w {in_status=0; next}
	{print}
' "${file}" >"${tmp}"
mv "${tmp}" "${file}"
EOF

cat >"${STUB}/adr" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
dir="${ADR_TEST_DIR:-docs/adr}"
cmd="${1:-}"
shift || true

case "${cmd}" in
new)
	# Optional: ignore -s style flags if present
	title="$*"
	title="${title#"${title%%[![:space:]]*}"}"
	max=0
	for f in "${dir}"/[0-9][0-9][0-9][0-9]-*.md; do
		[[ -f ${f} ]] || continue
		base="$(basename "${f}")"
		n=$((10#${base%%-*}))
		(( n > max )) && max=${n}
	done
	next=$((max + 1))
	slug="$(printf '%s' "${title}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g')"
	[[ -n ${slug} ]] || slug="untitled"
	num=$(printf '%04d' "${next}")
	path="${dir}/${num}-${slug}.md"
	cat >"${path}" <<ADREOF
# ${next}. ${title}

## Status

Accepted

## Context

## Decision

## Consequences
ADREOF
	echo "${path}"
	;;
link)
	# adr link NEW Supercedes OLD "Superceded by"
	new_num="$1"
	rel="$2"
	old_num="$3"
	rev="${4:-}"
	n_new=$(printf '%04d' "$((10#${new_num}))")
	n_old=$(printf '%04d' "$((10#${old_num}))")
	newf=( "${dir}"/${n_new}-*.md )
	oldf=( "${dir}"/${n_old}-*.md )
	[[ -f ${newf[0]} && -f ${oldf[0]} ]] || exit 1
	if [[ ${ADR_LINK_FAIL:-} == 1 ]]; then
		echo "stub adr link forced failure" >&2
		exit 1
	fi
	new_base="$(basename "${newf[0]}")"
	old_base="$(basename "${oldf[0]}")"
	# Append link under Status of new ADR
	tmp="$(mktemp)"
	awk -v rel="${rel}" -v base="${old_base%.md}" -v file="${old_base}" '
		BEGIN{done=0; in_status=0}
		/^## Status$/{in_status=1; print; next}
		in_status && NF && !done {
			print
			print ""
			print rel " [" base "](" file ")"
			done=1
			in_status=0
			next
		}
		{print}
	' "${newf[0]}" >"${tmp}"
	mv "${tmp}" "${newf[0]}"
	# Append reverse on old + set Superceded by status line
	tmp="$(mktemp)"
	awk -v rev="${rev}" -v base="${new_base%.md}" -v file="${new_base}" '
		BEGIN{done=0; in_status=0; replaced=0}
		/^## Status$/{in_status=1; print; next}
		in_status && NF && !replaced {
			print rev " [" base "](" file ")"
			replaced=1
			in_status=0
			next
		}
		{print}
	' "${oldf[0]}" >"${tmp}"
	mv "${tmp}" "${oldf[0]}"
	;;
generate)
	sub="${1:-}"
	if [[ ${sub} == toc ]]; then
		echo "# Architecture Decision Records"
		echo
		for f in "${dir}"/[0-9][0-9][0-9][0-9]-*.md; do
			[[ -f ${f} ]] || continue
			base="$(basename "${f}" .md)"
			title="$(head -n1 "${f}" | sed 's/^# //')"
			echo "- [${title}](${base}.md)"
		done
	fi
	;;
*)
	echo "stub adr: unknown ${cmd}" >&2
	exit 1
	;;
esac
EOF

chmod +x "${STUB}"/*

export PATH="${STUB}:${PATH}"
export ADR_TEST_DIR="docs/adr"
export ADR_BIN="${STUB}"

# Seed Accepted ADR (heading Status)
cat >docs/adr/0001-record-architecture-decisions.md <<'EOF'
# 1. Record architecture decisions

## Status

Accepted

## Context

We need to record decisions.

## Decision

Use ADRs.

## Consequences

Good.
EOF

# Seed bullet-status ADR for dual-format coverage
cat >docs/adr/0002-bullet-status.md <<'EOF'
# 2. Bullet status example

- **Status:** Accepted
- **Date:** 2026-01-01

## Context

Bullet form.

## Decision

Keep both formats.

## Consequences

OK.
EOF

touch docs/adr/README.md

echo "# test-create-adr.sh"

# 1) create → Proposed
out="$("${CREATE_ADR}" "Plain Proposal")"
assert_file_contains "create sets Proposed" "Proposed" "${out}"
assert_eq "create prints path" "docs/adr/0003-plain-proposal.md" "${out}"

# 2) refuse -s
assert_exit "refuse -s" 1 "${CREATE_ADR}" -s 1 "Bad"

# 3) proposes Accepted (heading)
out="$("${CREATE_ADR}" --proposes 1 "Challenge One")"
assert_file_contains "propose marker" "<!-- adr-proposes:0001-record-architecture-decisions.md -->" "${out}"
assert_file_contains "propose human line" "Proposes to supersede" "${out}"
assert_file_contains "challenge Proposed" "Proposed" "${out}"

# 4) proposes Accepted (bullet)
out="$("${CREATE_ADR}" --proposes 2 "Challenge Bullet")"
assert_file_contains "bullet target marker" "<!-- adr-proposes:0002-bullet-status.md -->" "${out}"

# 5) invalid propose (non-Accepted) before adr new — no orphan
count_adr_files() {
	find docs/adr -maxdepth 1 -type f -name '[0-9]*.md' | wc -l | tr -d ' '
}
before="$(count_adr_files)"
assert_exit "reject propose non-Accepted" 1 "${CREATE_ADR}" --proposes 3 "Should Fail"
after="$(count_adr_files)"
assert_eq "no orphan after bad proposes" "${before}" "${after}"

# 6) reject
rej="$("${CREATE_ADR}" "To Reject")"
"${CREATE_ADR}" reject "${rej}" >/dev/null
assert_file_contains "reject sets Rejected" "Rejected" "${rej}"

# 7) accept with supersession
ch="$("${CREATE_ADR}" --proposes 1 "Accept Me")"
"${CREATE_ADR}" accept "${ch}" >/dev/null
assert_file_contains "accept Accepted" "Accepted" "${ch}"
if grep -q 'adr-proposes' "${ch}"; then
	echo "not ok - markers stripped after accept" >&2
	FAILS=$((FAILS + 1))
else
	echo "ok - markers stripped after accept"
fi
assert_file_contains "old Superceded by" "Superceded by" "docs/adr/0001-record-architecture-decisions.md"
assert_file_contains "new Supercedes" "Supercedes" "${ch}"
assert_file_contains "toc refreshed" "Architecture Decision Records" "docs/adr/README.md"

# 8) accept rollback when adr link fails
# Re-accept path: create fresh Accepted target + proposal
cat >docs/adr/0009-rollback-target.md <<'EOF'
# 9. Rollback target

## Status

Accepted

## Context

## Decision

## Consequences
EOF
ch="$("${CREATE_ADR}" --proposes 9 "Rollback Challenge")"
# Snapshot
cp "${ch}" "${WORKDIR}/chal.bak"
cp docs/adr/0009-rollback-target.md "${WORKDIR}/tgt.bak"
ADR_LINK_FAIL=1
export ADR_LINK_FAIL
set +e
"${CREATE_ADR}" accept "${ch}" >/dev/null 2>&1
got=$?
set -e
unset ADR_LINK_FAIL
export -n ADR_LINK_FAIL 2>/dev/null || true
assert_eq "accept fails when link fails" "1" "${got}"
assert_file_contains "rollback keeps Proposed" "Proposed" "${ch}"
assert_file_contains "rollback keeps target Accepted" "Accepted" "docs/adr/0009-rollback-target.md"

# 9) dual set_status on bullet file via reject/create already covered; force set via reject of bullet challenge leftover
# ensure set_status works on bullet: create proposes 2 already did Proposed on ## Status new files

if [[ ${FAILS} -gt 0 ]]; then
	echo "FAILED: ${FAILS} assertion(s)" >&2
	exit 1
fi
echo "ALL PASSED"
exit 0
