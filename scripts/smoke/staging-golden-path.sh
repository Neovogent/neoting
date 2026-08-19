#!/usr/bin/env bash
# METH Stage 15 — the golden-path smoke, against a DEPLOYED api.
#
# What this is for: proving that a deployed environment carries a working spine,
# not just a 200 from /healthz. The #90–#107 incident is the cautionary tale —
# `aws ecs wait services-stable` succeeded, /healthz answered, CI stayed green,
# and staging sat pinned at an eighteen-deploy-old build for a week. A health
# check proves a process is listening. This proves the product works.
#
# It is deliberately curl + node and nothing else: no pnpm install, no repo
# build, no Playwright. It has to run from a laptop, from a runner, or from a
# phone tether during a demo, against any base URL.
#
#   scripts/smoke/staging-golden-path.sh
#   NT_SMOKE_BASE=http://localhost:3000 scripts/smoke/staging-golden-path.sh
#
# WHAT IT WRITES. One document is archived and then un-archived, each through a
# full propose → review → approve cycle, because there is no other honest way to
# prove the constitution holds server-side. The environment is left as it was
# found; step 11 says so out loud if the reversal fails.
#
# Credentials are METH_MODE.md §7 — published demo fixtures on a `.test` domain,
# not secrets (METH_MODE §3.5).
set -uo pipefail

BASE="${NT_SMOKE_BASE:-https://api.neoting.neovogent.com}"
EMAIL="${NT_SMOKE_EMAIL:-shakib@neoting.test}"
PASSWORD="${NT_SMOKE_PASSWORD:-demo-neoting-2026}"
TOTP="${NT_SMOKE_TOTP:-000000}"

JAR="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$JAR" "$BODY"' EXIT

pass=0
fail=0

# ANSI only when stdout is a terminal — a CI log full of escape codes is worse
# than a plain one.
if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; D=$'\033[2m'; Z=$'\033[0m'; else G=''; R=''; D=''; Z=''; fi

ok()   { pass=$((pass + 1)); printf '  %sPASS%s %s\n' "$G" "$Z" "$1"; }
bad()  { fail=$((fail + 1)); printf '  %sFAIL%s %s\n' "$R" "$Z" "$1"; [ -s "$BODY" ] && printf '       %s%s%s\n' "$D" "$(head -c 400 "$BODY")" "$Z"; }
step() { printf '\n%s\n' "$1"; }

# JSON is read with node, not jq, and that is a decision rather than a habit: jq
# is absent from a stock Windows/Git Bash box — the demo laptop — while node >=
# 22 is an `engines` requirement of this repo, so it is present wherever the
# product is. Same reason for the UUID: Git Bash has no uuidgen, but
# `crypto.randomUUID` has been in node since 14.
#
# `field` takes a JS expression over `d`, the parsed body. An unparseable body or
# a missing path echoes the empty string rather than throwing, so callers test
# for emptiness instead of guarding every call.
field() {
  node -e '
    const fs = require("node:fs");
    let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    let v;
    try { v = eval(process.argv[2]); } catch { process.exit(0); }
    if (v === undefined || v === null) process.exit(0);
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$BODY" "$1" 2>/dev/null
}

idem() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }

# Every call goes through here so the cookie jar, the body capture and the
# status-code convention cannot drift between call sites. Echoes the status
# code; the response body is left in $BODY.
call() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE$path" \
      -b "$JAR" -c "$JAR" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $(idem)" \
      --data "$data"
  else
    curl -sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE$path" -b "$JAR" -c "$JAR"
  fi
}

command -v node >/dev/null || { echo "node is required (>= 22, same as the repo)"; exit 2; }
command -v curl >/dev/null || { echo "curl is required"; exit 2; }

printf '%s\n' "Neoting golden-path smoke -> $BASE"

# --------------------------------------------------------------------------
step '1 · the process is listening'
code=$(call GET /healthz)
if [ "$code" = 200 ]; then ok "/healthz $code"; else bad "/healthz expected 200, got $code"; fi

# --------------------------------------------------------------------------
# Before the good password, so a smoke against an environment with auth
# accidentally disabled fails here rather than passing everything below.
step '2 · a wrong password is refused'
code=$(call POST /v1/auth/sessions "{\"email\":\"$EMAIL\",\"password\":\"not-the-password\",\"totp\":\"$TOTP\"}")
if [ "$code" = 401 ]; then ok "refused: $code $(field 'd.code')"; else bad "expected 401, got $code"; fi

step '3 · log in'
code=$(call POST /v1/auth/sessions "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"totp\":\"$TOTP\"}")
if [ "$code" = 204 ] && grep -q nt_session "$JAR"; then
  ok '204 and an nt_session cookie'
else
  bad "login expected 204 + cookie, got $code"
  printf '\n%sLogin failed — everything below needs a session. Stopping.%s\n' "$R" "$Z"
  printf 'If this is staging: SESSION_SECRET must hold a real value in /neoting/staging/auth\n'
  printf 'AND the SERVING task definition must inject it (docs/runbooks/staging-demo.md §1–2).\n'
  exit 1
fi

# --------------------------------------------------------------------------
step '4 · who am I, and what can I see'
code=$(call GET /v1/me)
if [ "$code" = 200 ]; then
  biz=$(field 'd.businesses.length')
  ok "$(field 'd.user.email') · $(field 'd.practice.name') · $(field 'd.role') · $biz businesses in scope"
  if [ "${biz:-0}" -gt 0 ] 2>/dev/null; then
    ok 'the scope is non-empty'
  else
    bad 'no businesses in scope — memberships or the seed are missing'
  fi
else
  bad "/v1/me expected 200, got $code"
fi

# --------------------------------------------------------------------------
step '5 · the seeded read surfaces'
read_surface() { # path, count expression, label
  local code n
  code=$(call GET "$1")
  if [ "$code" != 200 ]; then bad "$3 expected 200, got $code"; return; fi
  n=$(field "$2")
  case "${n:-x}" in ''|*[!0-9]*) bad "$3 answered 200 but no countable payload"; return ;; esac
  if [ "$n" -gt 0 ]; then ok "$3 — $n"; else bad "$3 is empty (was the seed run?)"; fi
}
read_surface '/v1/documents?limit=50'         'd.data.length' 'documents'
read_surface '/v1/chases?limit=50'            'd.data.length' 'chases'
read_surface '/v1/bank-transactions?limit=50' 'd.data.length' 'bank transactions'
read_surface '/v1/action-proposals?limit=50'  'd.data.length' 'action proposals'

# --------------------------------------------------------------------------
step '6 · propose a state change (nothing executes)'
# The FIRST document is not good enough: the newest may be UNROUTED, and an
# unrouted document has no businessId — proposing against it is correctly
# refused with 422 NT-PRP-006 ("a referenced record is not reachable"), which
# reads as a product bug when it is the product working. Pick the newest
# document that actually belongs to a business.
call GET '/v1/documents?limit=50' >/dev/null
DOC=$(field 'd.data.find(x => x.businessId).id')
BIZ=$(field 'd.data.find(x => x.businessId).businessId')
if [ -z "$DOC" ]; then
  bad 'no ROUTED document to act on — cannot exercise the proposal path'
  printf '\n%s%d passed, %d failed%s\n' "$D" "$pass" "$fail" "$Z"
  exit 1
fi

archive_body() { printf '{"kind":"document.archive","businessId":"%s","payload":{"documentIds":["%s"],"archived":%s}}' "$BIZ" "$DOC" "$1"; }

code=$(call POST /v1/action-proposals "$(archive_body true)")
PROP=$(field 'd.id')
if [ "$code" = 201 ] && [ -n "$PROP" ]; then
  ok "proposal $PROP created, state $(field 'd.state')"
else
  bad "create expected 201, got $code"
  # Everything below acts on $PROP. Without it the remaining steps each 404 on
  # an empty path segment and step 11 announces a document left archived that
  # was never archived — six misleading failures for one cause.
  printf '
%sNo proposal to exercise. Skipping steps 7-11.%s
' "$D" "$Z"
  printf '
%s%d passed, %d failed%s — %s
' "$R" "$pass" "$fail" "$Z" "$BASE"
  exit 1
fi

# --------------------------------------------------------------------------
# THE BEAT THIS SCRIPT EXISTS FOR (Governance §10.3, METH_MODE §6 beat 5).
# Approve is unreachable until Read-review has been opened, enforced SERVER
# SIDE. A UI that merely hides the button would sail through every other check
# in this file and fail this one.
step '7 · approve WITHOUT review — the constitution, server-side'
ZEROS=0000000000000000000000000000000000000000000000000000000000000000
code=$(call POST "/v1/action-proposals/$PROP/approval" "{\"renderedSummaryHash\":\"$ZEROS\"}")
ntcode=$(field 'd.code')
if [ "$code" = 409 ] && [ "$ntcode" = NT-PRP-002 ]; then
  ok "refused: $code $ntcode — $(field 'd.detail')"
elif [ "$code" = 200 ]; then
  bad 'APPROVED WITHOUT REVIEW. The Review -> Approve gate is not enforced here.'
else
  bad "expected 409 NT-PRP-002, got $code $ntcode"
fi

step '8 · open the review'
code=$(call POST "/v1/action-proposals/$PROP/review" '{}')
HASH=$(field 'd.renderedSummaryHash')
if [ "$code" = 200 ] && [ -n "$HASH" ]; then
  ok "reviewed — $(field 'd.renderedSummary.title')"
else
  bad "review expected 200 + renderedSummaryHash, got $code"
fi

step '9 · approve, echoing the hash that was reviewed'
code=$(call POST "/v1/action-proposals/$PROP/approval" "{\"renderedSummaryHash\":\"$HASH\",\"comment\":\"golden-path smoke\"}")
state=$(field 'd.state')
if [ "$code" = 200 ] && [ "$state" = EXECUTED ]; then
  ok "executed — outcome $(field 'd.outcome')"
else
  bad "approve expected 200 EXECUTED, got $code $state"
fi

step '10 · a replayed approve does not execute twice'
code=$(call POST "/v1/action-proposals/$PROP/approval" "{\"renderedSummaryHash\":\"$HASH\"}")
ntcode=$(field 'd.code')
if [ "$code" = 409 ] && [ "$ntcode" = NT-PRP-005 ]; then
  ok 'refused: 409 NT-PRP-005 — execution consumes a proposal exactly once'
else
  bad "expected 409 NT-PRP-005, got $code $ntcode"
fi

# --------------------------------------------------------------------------
step '11 · put the document back (a new proposal, never an undo)'
call POST /v1/action-proposals "$(archive_body false)" >/dev/null
UNDO=$(field 'd.id')
call POST "/v1/action-proposals/$UNDO/review" '{}' >/dev/null
UHASH=$(field 'd.renderedSummaryHash')
code=$(call POST "/v1/action-proposals/$UNDO/approval" "{\"renderedSummaryHash\":\"$UHASH\",\"comment\":\"golden-path smoke — restore\"}")
if [ "$code" = 200 ]; then
  ok "$DOC restored to un-archived"
else
  bad "COULD NOT RESTORE $DOC — it is left ARCHIVED. Un-archive it before demoing."
fi

# --------------------------------------------------------------------------
step '12 · log out, and stay out'
code=$(call DELETE /v1/auth/sessions/current)
if [ "$code" = 204 ]; then ok '204'; else bad "logout expected 204, got $code"; fi

code=$(call GET /v1/me)
if [ "$code" = 401 ]; then ok '/v1/me is 401 after logout'; else bad "expected 401 after logout, got $code — the cookie still resolves"; fi

# --------------------------------------------------------------------------
printf '\n────────────────────────────────\n'
if [ "$fail" -eq 0 ]; then
  printf '%s%d passed, 0 failed%s — the spine is live at %s\n' "$G" "$pass" "$Z" "$BASE"
  exit 0
fi
printf '%s%d passed, %d failed%s — %s\n' "$R" "$pass" "$fail" "$Z" "$BASE"
exit 1
