import { z } from 'zod';

/**
 * The single place that reads `process.env` (Governance §11.5). Zod-validated,
 * fails fast at boot on a malformed value, and no other module touches
 * `process.env` directly.
 *
 * The Meta integration secrets are optional here on purpose: the app must boot
 * and serve `/healthz` without them. A fresh clone has empty placeholders, and
 * the Meta sandbox credentials have not been issued yet (issue #9). The webhook
 * fails CLOSED when they are unset — signatures cannot verify, so `POST` returns
 * 401 and the `GET` challenge 403 until the secrets are configured. This mirrors
 * the scaffold's other sandbox keys (Twilio, Xero…), which are also blank in
 * `.env.example`.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Pinned to 3000 by infra/envs/staging (ALB target group + security group).
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  // Empty = fail CLOSED, not "verification off": an empty secret makes every
  // signature/token check return false (POST 401 / GET 403). Set both for the
  // webhook to accept anything.
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),

  // The ingest queue (#12). `fixture` = in-memory (default — offline tests and
  // any dev without Redis); `bullmq` = real BullMQ on Redis. Selected by config,
  // not by import, so the webhook controller is identical either way.
  INGEST_QUEUE: z.enum(['fixture', 'bullmq']).default('fixture'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Object storage for sanitised documents (#16). `fixture` = in-memory
  // (offline tests, dev without MinIO); `s3` = real S3 / MinIO. Selected by
  // config, not by import. In staging S3_ENDPOINT is empty (real AWS endpoint)
  // and credentials come from the task role's default provider chain, so both
  // are blank there — not required.
  OBJECT_STORE: z.enum(['fixture', 's3']).default('fixture'),

  // The image normaliser (#23). `fixture` = passthrough, and it REFUSES HEIC
  // because it genuinely cannot read one; `sharp` = the real EXIF/HEIC path.
  // Selected by config rather than by import so unit tests stay offline and
  // deterministic — a test feeding four magic bytes and the word "image" must
  // not be handed to a real decoder that correctly rejects it.
  IMAGE_NORMALISER: z.enum(['fixture', 'sharp']).default('fixture'),
  S3_ENDPOINT: z.string().default(''), // e.g. http://localhost:9000 for MinIO; empty = AWS default
  S3_REGION: z.string().default('eu-west-2'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  // Coerce the string env value to a real boolean — z.coerce.boolean() treats any
  // non-empty string (including "false") as true, which is the wrong default.
  S3_FORCE_PATH_STYLE: z.string().default('false').transform((value) => value === 'true'),
  S3_BUCKET_DOCUMENTS: z.string().default('nt-local-docs'),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Fail fast and loud — but never print the values, they may be secret.
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}
