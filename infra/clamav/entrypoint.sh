#!/bin/sh
# nt/clamav entrypoint — see the Dockerfile header for the two modes.
#
# Environment (set by the task definitions in clamav.tf):
#   AV_SIGNATURE_BUCKET          the private signature bucket (required)
#   AV_SIGNATURE_PREFIX          prefix inside it, default signatures/
#   AV_SIGNATURE_REFRESH_SECONDS scanner only: re-pull cadence, default 3600
#
# Everything fails LOUD. A missing bucket, an empty prefix, a failed sync on a
# cold start — each exits non-zero with a sentence, so the stopped task says
# what went wrong instead of clamd dying on an empty database directory with
# a message about a file it could not find.
set -eu

MODE="${1:-clamd}"
DB_DIR=/var/lib/clamav
: "${AV_SIGNATURE_BUCKET:?AV_SIGNATURE_BUCKET is required (clamav.tf sets it on both task definitions)}"
PREFIX="${AV_SIGNATURE_PREFIX:-signatures/}"
S3_PREFIX="s3://${AV_SIGNATURE_BUCKET}/${PREFIX}"

log() { printf '%s nt-clamav[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" "$*"; }

# Only the database files move, in either direction. `.cvd` is a full
# database, `.cld` is one freshclam has patched locally with .cdiff updates;
# clamd reads both. Nothing else in the prefix is ours to copy.
sync_db_down() {
  aws s3 sync "$S3_PREFIX" "$DB_DIR" --no-progress --exact-timestamps \
    --exclude '*' --include '*.cvd' --include '*.cld'
}
sync_db_up() {
  aws s3 sync "$DB_DIR" "$S3_PREFIX" --no-progress \
    --exclude '*' --include '*.cvd' --include '*.cld'
}

have_database() {
  # main + daily are the minimum clamd will start on; bytecode is optional.
  ls "$DB_DIR"/main.cvd "$DB_DIR"/main.cld >/dev/null 2>&1 \
    && ls "$DB_DIR"/daily.cvd "$DB_DIR"/daily.cld >/dev/null 2>&1
}

case "$MODE" in
  clamd)
    log "pulling signatures from $S3_PREFIX"
    if ! sync_db_down; then
      log "ERROR: could not sync the signature database from $S3_PREFIX (IAM? bucket name?)"
      exit 1
    fi
    if ! have_database; then
      log "ERROR: no main+daily database under $S3_PREFIX. Run the freshclam-publish task first (docs/runbooks/virus-scanning.md step 2)."
      exit 1
    fi
    chown -R clamav:clamav "$DB_DIR"

    # Hourly refresh from S3 — never from the public mirrors — then RELOAD so
    # the running daemon picks the new database up without a restart. A failed
    # pull is logged and retried next hour; clamd keeps the database it has.
    REFRESH="${AV_SIGNATURE_REFRESH_SECONDS:-3600}"
    (
      while :; do
        sleep "$REFRESH"
        if sync_db_down && have_database; then
          chown -R clamav:clamav "$DB_DIR"
          if clamdscan --reload >/dev/null 2>&1; then
            log "signatures refreshed and clamd reloaded"
          else
            log "WARNING: signatures refreshed but clamd did not acknowledge RELOAD"
          fi
        else
          log "WARNING: hourly signature refresh failed; keeping the current database"
        fi
      done
    ) &

    log "starting clamd (TCP 3310)"
    exec clamd --foreground --config-file=/etc/clamav/clamd.conf
    ;;

  freshclam-publish)
    # Pull the current bundle first so freshclam applies incremental .cdiff
    # patches instead of re-downloading ~250 MB — the mirror-abuse the design
    # exists to avoid. A cold prefix (first run ever) is fine: freshclam then
    # fetches the full set, once.
    log "pulling current signatures from $S3_PREFIX (cdiff base)"
    sync_db_down || log "no existing bundle to patch; freshclam will download the full database"
    chown -R clamav:clamav "$DB_DIR"

    log "running freshclam against database.clamav.net"
    freshclam --config-file=/etc/clamav/freshclam.conf --datadir="$DB_DIR" --stdout

    if ! have_database; then
      log "ERROR: freshclam finished but left no main+daily database; publishing nothing"
      exit 1
    fi
    log "publishing to $S3_PREFIX"
    sync_db_up
    log "published: $(ls "$DB_DIR" | tr '\n' ' ')"
    ;;

  *)
    exec "$@"
    ;;
esac
