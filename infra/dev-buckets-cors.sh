#!/usr/bin/env bash
#
# CORS on the shared DEV documents bucket, so a browser on localhost can upload.
#
# ── Why this file exists ────────────────────────────────────────────────────
#
# The three `nt-dev-*` buckets are bootstrap resources: created by CLI on
# 31 Aug 2026 for `docs/runbooks/live-local.md`, deliberately NOT in Terraform
# state, and therefore inheriting nothing from `modules/storage`. That module
# already carries the CORS rule every browser upload needs — but only for the
# buckets Terraform owns, which does not include these.
#
# The consequence was found the hard way on 2 Sep 2026. A client photographed
# two receipts in the portal, pressed Send to accountant, and got "2 photos did
# not send". The API was blameless: it minted the presigned PUT correctly and
# logged nothing, because the request never reached us. The bucket had no CORS
# configuration, so the browser's preflight was answered `403` and the PUT was
# never attempted. The rule was then applied BY HAND — one `aws s3api
# put-bucket-cors` against one bucket, recorded nowhere.
#
# A rule applied by hand to one bucket silently un-fixes itself on the next
# environment. This script is that command, written down, so the next dev
# bucket inherits it and so anybody can verify the current one.
#
# ⚠ THIS IS FOR THE DEV BUCKETS ONLY. Staging and production get their CORS
# from `modules/storage/main.tf` via `envs/*/main.tf`, and their origin lists
# are the real hosts. **`localhost` must never appear on a staging or
# production bucket** — a presigned URL is bearer authority over a client's
# financial records, and any page a user has open could drive an upload with
# one it had somehow obtained. Do not "unify" this with the module.
#
# ── Usage ───────────────────────────────────────────────────────────────────
#
#   AWS_PROFILE=nt ./infra/dev-buckets-cors.sh          # apply
#   AWS_PROFILE=nt ./infra/dev-buckets-cors.sh --check  # print, change nothing
#
# Idempotent: `put-bucket-cors` replaces the whole configuration, so running it
# twice is running it once.

set -euo pipefail

ACCOUNT_ID="${NT_DEV_ACCOUNT_ID:-252959251643}"
REGION="${NT_DEV_REGION:-eu-west-2}"
BUCKET="nt-dev-docs-${ACCOUNT_ID}"

# The Vite dev server's two addresses. Both are real: a browser treats
# `localhost` and `127.0.0.1` as different origins, and which one a developer
# has in the address bar is not something this script can know.
#
# The methods and headers mirror `modules/storage/main.tf` exactly, and the
# reasoning lives there rather than being restated:
#   PUT/GET only, `content-type` the only allowed header (it is the only one
#   `s3-document-store.ts` signs into the intent, and a preflight fails closed
#   on anything else), ETag exposed so a failed upload is diagnosable.
read -r -d '' CORS <<'JSON' || true
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:5173", "http://127.0.0.1:5173"],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["content-type"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
JSON

if [[ "${1:-}" == "--check" ]]; then
  echo "Bucket: ${BUCKET} (${REGION})"
  echo "--- live configuration ---"
  # ⚠ "no CORS rule" and "the call failed" are DIFFERENT ANSWERS and must not
  # share a sentence. Collapsing them is the same mistake this whole change
  # exists to fix: a stale SSO token would otherwise print a confident
  # "NO CORS CONFIGURATION" and send someone off to re-apply a rule that is
  # already there. `NoSuchCORSConfiguration` is the one error that means what
  # it says; anything else is passed through verbatim.
  if out="$(aws s3api get-bucket-cors --bucket "${BUCKET}" --region "${REGION}" 2>&1)"; then
    echo "${out}"
  elif grep -q 'NoSuchCORSConfiguration' <<<"${out}"; then
    echo "NO CORS CONFIGURATION — every browser upload to this bucket fails at the preflight."
  else
    echo "COULD NOT READ THE CONFIGURATION. This says nothing about whether a rule exists:"
    echo "${out}"
    exit 1
  fi
  echo "--- what this script would apply ---"
  echo "${CORS}"
  exit 0
fi

aws s3api put-bucket-cors \
  --bucket "${BUCKET}" \
  --region "${REGION}" \
  --cors-configuration "${CORS}"

echo "Applied CORS to ${BUCKET}. Verify with: $0 --check"
