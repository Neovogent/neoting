#!/usr/bin/env bash
# pnpm verify:parity — the local/staging parity smoke.
#
# What this proves: the CONTAINERISED local stack (docker compose --profile
# full) runs the same spine, through the same adapters, as the staging ECS
# tasks — real Redis queue, real object store, real image normaliser, real PDF
# guard, real signed-cookie sessions — and that the golden path (sign in →
# propose → review → approve → un-archive) holds against it. "It works on my
# machine" then means the machine staging is, not the machine your laptop was.
#
# What this deliberately does NOT prove, each with the reason it is exempt:
#   EXTRACTOR         demo locally — bedrock needs AWS credentials and spends
#                     real money; replay covers the adapter code in tests.
#   OTP_MODE          demo locally — a TOTP code cannot be scripted without the
#                     seed publishing shared secrets. The smoke's 000000 IS the
#                     demo verifier working as specified.
#   STATEMENT_READER  none locally — Textract's multi-page path reads from S3
#                     and cannot read MinIO (.env.example).
#   EMAIL_SENDER      demo locally — SES will not accept MailHog as a region.
#
# It reuses scripts/smoke/staging-golden-path.sh — the same eleven steps that
# gate a staging deploy — so local and staging are measured by the SAME ruler.
# If this passes locally and stage 9's smoke fails, the difference is the
# environment, and that is the honest bisect this script exists to enable.
set -uo pipefail

cd "$(dirname "$0")/../.."

BASE="${NT_SMOKE_BASE:-http://localhost:3000}"

fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

# --- 1 · the full profile is actually up -----------------------------------
# `docker compose ps` (not docker ps) so the check is scoped to this project's
# compose file, and --status running so a crash-looping api cannot pass.
running=$(docker compose --profile full ps --status running --format '{{.Service}}' 2>/dev/null || true)
for svc in api workers; do
  printf '%s\n' "$running" | grep -qx "$svc" \
    || fail "service '$svc' is not running. Start the stack with: docker compose --profile full up -d"
done
echo "compose: api + workers running"

# --- 2 · the container runs staging's switches -----------------------------
# Asserted INSIDE the api container, not from the compose file: the point is
# what the process actually loaded, after every layer of env precedence had
# its say. The five asserted here are the five staging pins CI stage 9
# deploys with (services.tf); the divergences are the documented list above.
docker compose exec -T api node -e '
  const want = {
    INGEST_QUEUE: "bullmq",
    OBJECT_STORE: "s3",
    IMAGE_NORMALISER: "sharp",
    DOCUMENT_GUARD: "qpdf",
    AUTH_MODE: "session",
  };
  const wrong = Object.entries(want).filter(([k, v]) => process.env[k] !== v);
  if (wrong.length > 0) {
    for (const [k, v] of wrong) console.error(`  ${k}=${process.env[k] ?? "(unset)"} — staging runs ${v}`);
    process.exit(1);
  }
  console.log("switches: " + Object.entries(want).map(([k, v]) => `${k}=${v}`).join(" "));
' || fail "the api container is not running staging's adapter switches — this stack is not parity, fix the compose env before trusting any result from it"

# --- 3 · the golden path, same ruler as staging ----------------------------
# Via bash, not exec'd directly: the file is committed without an executable
# bit, and this wrapper has no business changing another script's mode.
NT_SMOKE_BASE="$BASE" exec bash scripts/smoke/staging-golden-path.sh
