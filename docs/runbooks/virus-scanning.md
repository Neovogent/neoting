# Virus scanning — ClamAV, end to end

**Governance §11.4 step 4 · SoT §4 Stage 1 · `AWS_Foundation_Runbook.md` Step 8 · `infra/envs/staging/clamav.tf`**

This is the operational runbook for the virus scan every ingested document goes
through, and — the part that matters today — the exact, ordered steps that turn
it on in staging. **As of 14 Oct 2026 nothing is being scanned in any deployed
environment**: the code is real and tested, the infrastructure exists, and the
switch is off. Read the state table before doing anything.

## How it works

```
upload / email / WhatsApp bytes
        │
        ▼
sanitise()  step 1 sniff → 2 allowlist → 3 size cap → 4 VIRUS SCAN → 5 EXIF/HEIC → 6 PDF → 7 ZIP
                                                  │
                                 clamd INSTREAM over TCP 3310 (zero-dep client,
                                 lib/sanitisation/clamd-virus-scanner.ts)
                                                  │
                        ┌──────────────┬──────────┴───────────┬──────────────────────────┐
                        ▼              ▼                      ▼                          ▼
                   "stream: OK"   "… FOUND"             ERROR / timeout /           (fixture mode)
                   continue       REJECTED, NT-ING-004  refused / unreachable        EICAR string only;
                                  reason on the row     THROW → job retries →        nothing else is
                                  + original bytes →    ingest DLQ pages             scanned
                                  quarantine bucket     (fail CLOSED, never pass,
                                  (its write event      never "rejected")
                                  = operator alert)
```

- **Where it runs:** in the workers (`worker/main.ts` for web/portal/WhatsApp,
  `worker/email-intake-main.ts` for email), on the bytes in memory, before
  anything is stored as a document. Not on the request path (Gov §7).
- **The daemon:** the ECS service `nt-<env>-clamav` — our image
  `nt/clamav` (`infra/clamav/Dockerfile`: the official `clamav/clamav` base,
  `clamd` on 3310, signatures pulled from the private S3 bucket
  `nt-<env>-avdefs-<acct>` on start and hourly). Workers reach it by the Cloud
  Map name `clamav.<env>.nt.internal`; the clamav security group admits only
  the app security group on 3310.
- **The signatures:** the scheduled task `nt-<env>-clamav-freshclam` (same
  image, command `freshclam-publish`) runs freshclam against clamav.net six
  times a day and publishes to S3. **The scanner never talks to clamav.net.**
- **A hit:** the document is `REJECTED` with `NT-ING-004` and the plain-English
  reason on the row (web/portal), or the attachment is listed as rejected
  (email) / the job dead-letters (WhatsApp, until the `s3_key` nullability
  change). The ORIGINAL bytes go to `nt-<env>-quarantine-<acct>` as
  `<channel>/<sha256>` with the signature in metadata; the bucket's
  EventBridge rule emails the alerts topic; a daily alarm nags while anything
  sits there; 90-day lifecycle. The worker can write there and cannot read.
- **An outage:** fails closed. The job throws `VirusScanUnavailableError`,
  BullMQ retries, three failures land in the ingest DLQ (which pages). A
  document is never marked rejected because *we* were down.

## Configuration

| Variable | Values | Where set |
|---|---|---|
| `VIRUS_SCANNER` | `fixture` (default — EICAR only, **scans nothing**) · `clamd` | `.env`, docker-compose, `services.tf` `common_environment` |
| `CLAMD_HOST` / `CLAMD_PORT` | daemon address, default `127.0.0.1:3310` | same |
| `CLAMD_TIMEOUT_MS` | whole-scan deadline, default 180 000 | code default; override if p99 says so |
| `QUARANTINE_BUCKET` | bucket for hits; empty = keep nothing | `services.tf`; **required with `clamd` under `NODE_ENV=production`** |

The worker logs its mode at every boot. `fixture` is a **WARN** line that says
"NOTHING IS BEING SCANNED"; `clamd` logs the target and whether it answered
`PING`.

## State as of 14 Oct 2026 (all read-only checks)

| Thing | State |
|---|---|
| Code | real clamd client, quarantine writer, config, tests — this PR |
| `VIRUS_SCANNER` on the task definitions | `fixture` (stated explicitly in `services.tf`) |
| ECR `nt/clamav` | **empty** — no image has ever been pushed |
| ECS `nt-staging-clamav` | desired 0, running 0, task def rev 1 pointing at a tag that does not exist |
| S3 `nt-staging-avdefs-…` | **empty** — freshclam-publish has never run |
| EventBridge Scheduler `nt-staging-clamav-freshclam` | `DISABLED` |
| S3 `nt-staging-quarantine-…` | empty (correct — nothing has been caught) |
| Cloud Map `staging.nt.internal` / SG ingress / app-role quarantine grant | in Terraform, applied on merge (`TERRAFORM_AUTO_APPLY=true`) — inert until the steps below |

## Switching it on in staging — in this order, one step per verification

Each step is safe to stop after. Doing step 5 before steps 1–4 makes every
ingest job fail closed and fill the DLQ: loud and correct, but an outage.

**0. Prerequisite: the Terraform in this PR is applied.** Merging does that
(`vars.TERRAFORM_AUTO_APPLY` is `true`). Check the plan in the PR's
`terraform.yml` run: expect the Cloud Map namespace + service, one SG ingress
rule, one IAM policy on `nt-staging-app`, new task-definition revisions
(clamav: port mapping; api/workers/email-intake/migrate: the four env vars at
their defaults). Nothing with `desired_count`.

**1. Build and push the image** (ARM64, from a machine with Docker):

```sh
aws ecr get-login-password --region eu-west-2 \
  | docker login --username AWS --password-stdin 252959251643.dkr.ecr.eu-west-2.amazonaws.com
docker buildx build --platform linux/arm64 --push \
  -t 252959251643.dkr.ecr.eu-west-2.amazonaws.com/nt/clamav:$(git rev-parse --short HEAD) \
  infra/clamav
```

Then register task-definition revisions for BOTH families pointing at that tag
(the `bootstrap` tag in Terraform does not exist, by design — same convention as
services.tf). The scheduler pins the freshclam **revision**, so update it too:

```sh
# For each of nt-staging-clamav and nt-staging-clamav-freshclam:
aws ecs describe-task-definition --task-definition nt-staging-clamav --query taskDefinition > live.json
jq --arg image "<registry>/nt/clamav:<tag>" '.containerDefinitions |= map(.image = $image)
   | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)' live.json > next.json
aws ecs register-task-definition --cli-input-json file://next.json
```

**2. Publish signatures once, by hand, and check the bucket:**

```sh
aws ecs run-task --cluster nt-staging --launch-type FARGATE \
  --task-definition nt-staging-clamav-freshclam:<new revision> \
  --network-configuration "awsvpcConfiguration={subnets=[<public subnet ids>],securityGroups=[<nt-staging-clamav sg>],assignPublicIp=ENABLED}"
# wait for STOPPED with exit code 0, then:
aws s3 ls s3://nt-staging-avdefs-252959251643/signatures/     # expect main.cvd daily.c?d bytecode.cvd
```

Logs: `/nt/staging/clamav`, stream prefix `freshclam`. Then enable the
schedule: `state = "ENABLED"` on `aws_scheduler_schedule.clamav_freshclam` in
clamav.tf and point its `task_definition_arn` at a CI-registered revision (or
accept Terraform's), in a PR of its own.

**3. Start one scanner and watch it load:**

```sh
aws ecs update-service --cluster nt-staging --service nt-staging-clamav \
  --task-definition nt-staging-clamav:<new revision> --desired-count 1
```

Expect 2–3 minutes to HEALTHY (database load; `startPeriod` 180 s, grace
300 s). If it is OOM-killed before logging anything, the database outgrew 4 GB
— raise `clamav_task_size.memory`, do not shrink anything else. Confirm Cloud
Map has an instance: `aws servicediscovery discover-instances --namespace-name
staging.nt.internal --service-name clamav`.

**4. Flip the switch** — `VIRUS_SCANNER` from `fixture` to `clamd` in
`services.tf` `common_environment`, PR, merge (auto-apply registers the task
definition revisions; the next CI deploy of api/workers picks them up — or
`aws ecs update-service --force-new-deployment` on `nt-staging-workers` and
`nt-staging-email-intake`). The workers' boot log must now say
`virus scanner: clamd at clamav.staging.nt.internal:3310` and `answered PONG`.

**5. Prove it with EICAR, not with a unit test.** Upload the 68-byte EICAR
test file (`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`,
saved as `eicar.txt` inside a PDF wrapper or ZIP — the pipeline's step 1 refuses
a bare `.txt`) through the web UI. Expect: document `REJECTED` with
`NT-ING-004` "flagged by our virus scan"; an object at
`client/<sha256>` (or `accountant_upload/…`) in the quarantine bucket; the
"MALWARE QUARANTINED" email from the alerts topic within a minute. Then upload
a normal receipt and confirm it extracts as before.

**6. Close the door** — in the SAME PR as, or after, step 4 is proven: add the
production boot gate to `config/env.ts`'s `superRefine` (the pattern the
DOCUMENT_GUARD gate uses):

```ts
if (env.NODE_ENV === 'production' && env.VIRUS_SCANNER === 'fixture') {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['VIRUS_SCANNER'],
    message: 'VIRUS_SCANNER=fixture scans nothing — set VIRUS_SCANNER=clamd' });
}
```

and add `VIRUS_SCANNER: 'clamd', QUARANTINE_BUCKET: 'nt-staging-quarantine-1'`
to the `PRODUCTION` fixture in `env.test.ts`, replacing the test that pins the
deferral. Doing this BEFORE step 4 crash-loops the next workers deploy.

## Follow-up decisions (owner)

- **The old SQS design's leftovers.** `nt-staging-av-object-created` →
  `nt-staging-av-scan` queue, its DLQ, and the `av-queue-age` / `av-dlq-non-empty`
  alarms have no consumer under this design and the queue-age alarm will fire
  whenever objects land in docs/receipts. Recommended: remove the EventBridge
  rule + target, both queues and both alarms from clamav.tf (a deletion, so it
  is a decision, not a drive-by). The scanner role's SQS and tagging grants go
  with them.
- **Prod** should run the scanner on FARGATE (not Spot) with ≥ 2 tasks — the
  comment on `aws_ecs_service.clamav` already says so.
- **Observability** — add `nt-staging-clamav` to observability.tf's
  `local.ecs_services` once it runs, so it gets the task-shortfall and
  memory-high alarms.

## Local development

```sh
docker compose --profile full --profile av up -d --build   # adds the clamav container (4 GB, 250 MB download first time)
VIRUS_SCANNER=clamd docker compose --profile full --profile av up -d workers   # or export it before `up`
```

On the host (`pnpm dev`): `docker compose --profile av up -d clamav`, then
`VIRUS_SCANNER=clamd CLAMD_HOST=127.0.0.1` in `.env`. The MinIO bucket
`nt-local-quarantine` exists for `QUARANTINE_BUCKET`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| worker boot: `virus scanner: FIXTURE … NOTHING IS BEING SCANNED` | `VIRUS_SCANNER` unset or `fixture` | step 4 |
| worker boot: `did not answer PING` | clamd still loading, service at 0, SG/Cloud Map not applied | wait 3 min; check steps 0 and 3 |
| every ingest job retrying with `virus scan unavailable: … ECONNREFUSED` | same as above, after boot | same — scans fail closed by design |
| `virus scan unavailable: clamd replied "INSTREAM size limit exceeded. ERROR"` | file over `StreamMaxLength` (100M) — should be impossible after step 3's cap | raise both caps in the same PR, or neither |
| clamav task OOM-killed on start | signature DB outgrew memory | raise `clamav_task_size.memory` in clamav.tf |
| clamav task exits `no main+daily database under s3://…` | step 2 not done / IAM | run freshclam-publish; check `ReadVirusSignatures` |
| `av-queue-age` alarm | the old design's unconsumed queue | see follow-up decisions; not a scanning failure |
