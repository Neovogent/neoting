#!/usr/bin/env node
// Env-key parity: .env.example ⇆ the staging ECS task definitions.
//
// The failure this kills: a variable added to `.env.example` and `env.ts`
// but never to `services.tf` boots locally, passes every CI stage, and dies
// on ECS at task start — where it presents as a deploy failure, not as the
// one-line config gap it is. services.tf itself records a live specimen: the
// task definition said S3_BUCKET_DOCS while env.ts read S3_BUCKET_DOCUMENTS,
// and nothing caught it before the deploy. This script makes that class of
// drift a red PR instead.
//
// The two files are NOT expected to match one-to-one, and pretending they
// should would just breed a rubber-stamp allowlist. Three honest categories:
//
//   COMPOSED   ECS cannot interpolate a Secrets Manager value into another
//              environment variable, so the URL the app reads is assembled at
//              boot from parts (config/env.ts, src/db/migrate.ts). Locally the
//              URL is stated whole. The check asserts every PART is on ECS.
//   LOCAL_ONLY keys that exist only against docker-compose stand-ins, dormant
//              ID-scope sandboxes (D40/D42), or switches staging leaves at
//              their code default. Every entry carries its reason — an entry
//              without a defensible reason is drift hiding in an allowlist.
//   ECS_ONLY   the reverse direction: keys the task definitions set that a
//              laptop never needs (composition parts, task identity, real
//              AWS resources).
//
// Deliberately plain node + regex over the .tf, no HCL parser, no deps: the
// keys sit in literal `{ name = "X", ... }` maps, and a parser dependency
// would need a human approval (CLAUDE.md) to save six lines of regex.
//
// Run: node scripts/check-env-parity.mjs   (CI runs it in the verify job)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

// Uncommented KEY=... lines only. A commented example (`# WHATSAPP_…`) is
// documentation, not a key the app is promised.
const envExampleKeys = new Set(
  [...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
);

// Both `environment` ({ name, value }) and `secrets` ({ name, valueFrom })
// entries. The [A-Z0-9_] anchor is what excludes every other `name =` in the
// file (task-definition names, container names — all lowercase/dashed).
const ecsKeys = new Set(
  [...read('infra/envs/staging/services.tf').matchAll(/\{\s*name\s*=\s*"([A-Z][A-Z0-9_]*)"/g)].map(
    (m) => m[1],
  ),
);

// Local states the URL; ECS states the parts and the app composes them
// (withDerivedRedisUrl in config/env.ts, src/db/migrate.ts for Prisma).
const COMPOSED = {
  DATABASE_URL: ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DB_APP_USER', 'DB_APP_PASSWORD'],
  DIRECT_URL: ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DB_MIGRATOR_USER', 'DB_MIGRATOR_PASSWORD'],
  REDIS_URL: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_TLS', 'REDIS_AUTH_TOKEN'],
};

const LOCAL_ONLY = {
  // MinIO stands in for S3 (Governance §2). On ECS the SDK uses the real
  // endpoint and the task role — an endpoint override or a static key there
  // would be a bug, not a gap.
  S3_ENDPOINT: 'MinIO endpoint override; ECS uses real S3 + task-role IAM',
  S3_ACCESS_KEY_ID: 'MinIO static credential; ECS uses task-role IAM',
  S3_SECRET_ACCESS_KEY: 'MinIO static credential; ECS uses task-role IAM',
  S3_FORCE_PATH_STYLE: 'MinIO needs path-style; real S3 does not',
  S3_REGION: 'wired with default eu-west-2 (env.ts); ECS rides the default, local states it beside the MinIO endpoint',
  // MailHog stands in for SES; staging sends through EMAIL_SENDER=ses.
  SMTP_HOST: 'MailHog stand-in; staging sends via SES, not SMTP',
  SMTP_PORT: 'MailHog stand-in; staging sends via SES, not SMTP',
  MAILHOG_API_URL: 'the EMAIL_SOURCE=mailhog poller reads it; MailHog is local-only',
  // Switches staging leaves at their code default, stated locally for
  // discoverability. If staging ever needs the non-default, the key moves to
  // services.tf and off this list.
  // (EMAIL_SOURCE used to sit here. The committed services.tf sets it now, so
  // its reason had expired and the hygiene check below evicted it — exactly as
  // it did the Stripe keys. Not a D50 change; found by running this script,
  // which is what it is for.)
  //
  // (SMS_ORIGINATION_IDENTITY sat here through two commits and is gone for
  // good now that the SMS lane's services.tf is committed — the eviction that
  // #297 had to undo, re-applied at the moment it became true. The lesson from
  // that round trip is worth keeping: this script reads the WORKING TREE, so
  // run it inside `git worktree add --detach <dir> HEAD` before trusting what
  // it says about a file somebody is mid-edit on.)
  SMS_REGION: 'partner of SMS_ORIGINATION_IDENTITY; stated on ECS when the number activates',
  WHATSAPP_PRACTICE_MAP:
    'controller-side override only since Practice.whatsappPhoneNumberId landed (1 Sep 2026); staging maps practices in the DB, not the task definition',
  AUTH_MODE: undefined, // never allowlist a mode switch that IS on ECS — see the check below
  // ID-dormant sandboxes (D40/D42 supersede D4/D6 for ID): the integrations
  // are fenced out of the release, the keys stay documented for v1.
  TWILIO_ACCOUNT_SID: 'SMS is cut from ID; sandbox key documented for v1 (D32/D45 context)',
  TWILIO_AUTH_TOKEN: 'SMS is cut from ID; sandbox key documented for v1',
  TWILIO_VERIFY_SERVICE_SID: 'SMS is cut from ID; sandbox key documented for v1',
  TWILIO_MESSAGING_SERVICE_SID: 'SMS is cut from ID; sandbox key documented for v1',
  // (The twelve D50 ledger keys sat here while the lane was code-only. They
  // are gone now that `services.tf` sets all of them — the hygiene check below
  // evicted them the moment the infra landed, exactly as it did the Stripe
  // keys and as `docs/runbooks/ledger-connections.md` said it would.)
  TRUELAYER_CLIENT_ID: 'bank feeds dormant in ID (D40)',
  TRUELAYER_CLIENT_SECRET: 'bank feeds dormant in ID (D40)',
  COMPANIES_HOUSE_API_KEY: 'not wired to a live lane yet; documented sandbox slot',
  HMRC_CLIENT_ID: 'not wired to a live lane yet; documented sandbox slot',
  HMRC_CLIENT_SECRET: 'not wired to a live lane yet; documented sandbox slot',
  // (VITE_* web vars are deliberately NOT here: the web app reads its
  // dev-mode switches from apps/web/.env.development, never from the root
  // .env — so they have no business in .env.example either. Stripe keys
  // used to sit here with a "BILLING=demo on staging" reason.
  // #206 made Stripe real on staging, services.tf now sets all of them, and
  // the hygiene check below evicted the entries — exactly as designed.)
};
delete LOCAL_ONLY.AUTH_MODE; // documentation device above, not an entry

const ECS_ONLY = {
  NEOTING_ENV: 'synthetic-data allow-list key for seed-environment.ts; a laptop is not a named environment',
  DATABASE_HOST: 'composition part of DATABASE_URL/DIRECT_URL',
  DATABASE_PORT: 'composition part of DATABASE_URL/DIRECT_URL',
  DATABASE_NAME: 'composition part of DATABASE_URL/DIRECT_URL',
  DB_APP_USER: 'composition part of DATABASE_URL',
  DB_APP_PASSWORD: 'composition part of DATABASE_URL (Secrets Manager)',
  DB_MIGRATOR_USER: 'composition part of DIRECT_URL (RDS master secret)',
  DB_MIGRATOR_PASSWORD: 'composition part of DIRECT_URL (RDS master secret)',
  DB_APP_ROLE_PASSWORD: 'migrate task only: (re)asserts the nt_app role password',
  REDIS_HOST: 'composition part of REDIS_URL',
  REDIS_PORT: 'composition part of REDIS_URL',
  REDIS_TLS: 'composition part of REDIS_URL (transit encryption is on)',
  REDIS_AUTH_TOKEN: 'composition part of REDIS_URL (Secrets Manager)',
  KMS_KEY_ARN: 'real KMS key for S3 encryption context (ADR 0008); MinIO has no KMS',
  SERVICE_NAME: 'task-identity label for logs/metrics, set per task definition',
  WORKER_CONCURRENCY: 'worker tuning on ECS; the code default is right for a laptop',
  UPLOAD_URL_SECRET: 'fails closed on empty (env.ts:126), so local omits it until the web-upload lane is exercised locally',
};

// ⚠ DUPLICATE ENV NAMES IN A TASK DEFINITION, and the reason this check exists.
//
// A repeated `{ name = "X", ... }` in the same container's list is valid HCL,
// passes `terraform validate`, applies cleanly — and ECS silently takes the
// LAST one. On 15 Sep 2026 that swallowed a `LEDGER_ADAPTER` flip to `http`
// whole: the plan looked right, the apply said success, and the running task
// kept the `demo` value from an entry forty lines further down. Nothing
// anywhere reported a problem.
//
// ⚠ THE CEILING IS 1, AND THE FIRST VERSION OF THIS CHECK GOT IT WRONG. It was
// written with a ceiling of 4 — "a name may appear once per service list" —
// and proven with an injected FIVE copies, so it passed its own test while
// being unable to catch the two-entry bug it was written for. Measured instead
// of assumed: every name in services.tf appears exactly ONCE except
// SERVICE_NAME, which is genuinely set per service and is the whole allowlist.
// If a second name ever earns a place here, add it with its reason — do not
// raise the ceiling, because the ceiling is what catches the real shape.
const REPEATED_BY_DESIGN = new Set([
  'SERVICE_NAME', // one per task definition (api, workers, migrate, email-intake), each a different value
]);

function duplicateEnvNames(tf) {
  const counts = new Map();
  for (const m of tf.matchAll(/\{\s*name\s*=\s*"([A-Z][A-Z0-9_]*)"/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([name, n]) => n > 1 && !REPEATED_BY_DESIGN.has(name))
    .map(([name, n]) => `${name} (${n}x)`);
}

const failures = [];
const notes = [];

for (const key of [...envExampleKeys].sort()) {
  if (ecsKeys.has(key)) continue;
  if (key in COMPOSED) {
    const missing = COMPOSED[key].filter((part) => !ecsKeys.has(part));
    if (missing.length > 0) {
      failures.push(`${key} is composed on ECS but its parts are incomplete: missing ${missing.join(', ')}`);
    }
    continue;
  }
  if (key in LOCAL_ONLY) continue;
  failures.push(
    `${key} is in .env.example but not in infra/envs/staging/services.tf. ` +
      `Either add it to the task definitions (via the infra process — not this PR), ` +
      `or add it to LOCAL_ONLY in scripts/check-env-parity.mjs with a reason that survives review.`,
  );
}

// Allowlist hygiene: an entry for a key that no longer exists is dead config
// pretending to be a decision — exactly the smell this script polices.
for (const key of Object.keys(LOCAL_ONLY)) {
  if (!envExampleKeys.has(key)) failures.push(`LOCAL_ONLY lists ${key}, which is no longer in .env.example — remove the stale entry.`);
  if (ecsKeys.has(key)) failures.push(`LOCAL_ONLY lists ${key}, but services.tf sets it — the reason no longer holds, remove the entry.`);
}
for (const key of Object.keys(ECS_ONLY)) {
  if (!ecsKeys.has(key)) failures.push(`ECS_ONLY lists ${key}, which is no longer in services.tf — remove the stale entry.`);
}

// Reverse direction: a key ECS sets that neither .env.example documents nor
// ECS_ONLY explains is drift too — it means staging depends on something a
// developer cannot see.
for (const key of [...ecsKeys].sort()) {
  if (envExampleKeys.has(key)) continue;
  if (key in ECS_ONLY) continue;
  failures.push(
    `${key} is set on the ECS task definitions but absent from .env.example and unexplained. ` +
      `Document it in .env.example or add an ECS_ONLY reason in scripts/check-env-parity.mjs.`,
  );
}

if (notes.length > 0) console.log(notes.map((n) => `note: ${n}`).join('\n'));
for (const dup of duplicateEnvNames(read('infra/envs/staging/services.tf'))) {
  failures.push(
    `${dup} appears more times in services.tf than there are lists to hold it — a duplicate ` +
      `{ name = ... } is valid HCL and ECS silently takes the LAST one, so the value you can ` +
      `see in the plan may not be the one that runs.`,
  );
}

if (failures.length > 0) {
  console.error(`env parity check failed (${failures.length}):\n` + failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log(
  `env parity: ${envExampleKeys.size} .env.example keys ⇆ ${ecsKeys.size} ECS keys — every key present, composed, or explained.`,
);
