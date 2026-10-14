# syntax=docker/dockerfile:1
# --------------------------------------------------------------------------
# nt/clamav — the clamd daemon the workers' sanitisation step 4 talks to, and
# the freshclam publisher, in ONE image (clamav.tf §5: "the code that WRITES
# the signature bundle and the code that READS it ship together").
#
#   docker buildx build --platform linux/arm64 -t <ecr>/nt/clamav:<git-sha> infra/clamav
#
# ARM64, like every other task definition in staging. An x86 image dies with
# "exec format error" and nothing else (apps/api/CLAUDE.md).
#
# Two commands, selected by the container `command` on the task definition:
#
#   clamd              (default) pull the signature database from the private
#                      S3 prefix, start clamd on TCP 3310, re-pull hourly and
#                      ask clamd to reload. The ECS service `nt-<env>-clamav`.
#   freshclam-publish  run freshclam ONCE against database.clamav.net and
#                      publish the result to that same prefix, then exit. The
#                      scheduled task `nt-<env>-clamav-freshclam`.
#
# ⚠ The scanner NEVER runs freshclam itself. ClamAV's CDN rate-limits and
# blocklists by source IP, staging Fargate tasks share a small public-IP pool,
# and a crash-looping scanner hitting the mirrors on every start is how an
# account gets blocked — after which clamd keeps answering "clean" against a
# stale database. clamav.tf's signature-bucket banner is the long version.
#
# `_base` = the official image WITHOUT a baked-in database. The database comes
# from S3 at start; baking a copy in would ship a stale one that the hourly
# refresh then silently overrides, and would add ~250 MB to every pull.
#
# ⚠ THE DEBIAN VARIANT, NOT THE DEFAULT ALPINE ONE, AND THIS IS NOT TASTE.
# Checked against the registry on 14 Oct 2026: `clamav/clamav:1.4_base` (and
# `1.4`, `stable`, `1.4.6_base`) publish an amd64 manifest ONLY. Pointing an
# ARM64 task definition at it is the "exec format error and nothing else"
# failure apps/api/CLAUDE.md warns about. `1.4_base-debian13-slim` publishes
# amd64 + arm64 + ppc64le. If you bump the tag, re-check the manifest list
# (`docker manifest inspect clamav/clamav:<tag>`) before trusting it.
# --------------------------------------------------------------------------
FROM clamav/clamav:1.4_base-debian13-slim

# aws-cli for `s3 sync` in both modes — the price of not hand-rolling SigV4
# in shell. Debian's package; nothing else is added.
RUN apt-get update \
 && apt-get install -y --no-install-recommends awscli ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY clamd.conf     /etc/clamav/clamd.conf
COPY freshclam.conf /etc/clamav/freshclam.conf
COPY entrypoint.sh  /usr/local/bin/nt-clamav

RUN chmod 0755 /usr/local/bin/nt-clamav \
 && mkdir -p /var/lib/clamav /run/clamav \
 && chown -R clamav:clamav /var/lib/clamav /run/clamav

# clamd listens here; the task definition maps it and the clamav security
# group admits only the app security group (clamav.tf).
EXPOSE 3310

# Matches the task definition's healthCheck. start-period covers the 60–120 s
# database load — a shorter grace kills a healthy container mid-start.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD clamdscan --ping 1 >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/nt-clamav"]
CMD ["clamd"]
