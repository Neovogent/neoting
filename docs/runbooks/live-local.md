# Live-mode local development

Run the real pipeline on your laptop — real Bedrock extraction and chat,
real Textract statement OCR, real queue, real S3 — with hot reload instead of
the ~15-minute staging deploy. This is staging parity minus outbound email.

The architecture already supports this: every external dependency sits behind a
config switch (`apps/api/src/config/env.ts`). A cold clone defaults everything
to `demo`/`fixture` so it runs offline; this runbook flips the switches that
matter. **Nothing here changes staging or production.**

## Prerequisites

- Docker, pnpm, Node 22+ (the repo's normal toolchain).
- AWS credentials with `bedrock:InvokeModel` in **eu-west-2** on the models
  pinned in `.env.example`. The team convention is a profile named `nt`
  (`aws configure --profile nt`). Verify with:

  ```sh
  aws sts get-caller-identity --profile nt
  ```

## Setup

1. **Clone / pull `main`, install, start containers:**

   ```sh
   pnpm install
   pnpm build
   docker compose up -d
   ```

   The `pnpm build` is not optional on a cold clone: `@neoting/contracts`
   ships a compiled exports map and turbo gives `dev` no `dependsOn`, so
   `pnpm dev` on an unbuilt tree dies resolving the contracts package
   (`apps/api/CLAUDE.md`, #88/#90).

2. **Create `.env`** — copy `.env.example` to `.env` if you don't have one,
   then set exactly these keys (leave everything else at its example value):

   | Key | Value | Why |
   |---|---|---|
   | `AWS_PROFILE` | `nt` | Not in `.env.example`. The AWS SDK credential chain reads it; Bedrock needs it. Skip if your default chain already resolves. **A machine with no AWS setup at all** (a reviewer's laptop): skip this row and instead put `AWS_ACCESS_KEY_ID=` and `AWS_SECRET_ACCESS_KEY=` in `.env` with the scoped `nt-dev-pm` keys (IAM user limited to Bedrock invoke in eu-west-2, Textract, and the `nt-dev-*` buckets — ask Shakib for the two values). The SDK reads them from the environment; no AWS CLI or profile needed. `.env` is gitignored — they must never appear in a commit. |
   | `AUTH_MODE` | `session` | Real signed-cookie sessions — the web login wall cannot answer under `fixture`. |
   | `INGEST_QUEUE` | `bullmq` | Not in `.env.example`. Under the default `fixture` **no worker consumes uploads** — every document strands in Processing. |
   | `OBJECT_STORE` | `s3` | Not in `.env.example`. Stores bytes in MinIO (the `S3_*` values already point there). |
   | `IMAGE_NORMALISER` | `sharp` | Not in `.env.example`. Real image normalisation; sharp is a pnpm dependency, nothing to install. |
   | `AI_CHAT` | `bedrock` | The real chat model. Under `demo` the assistant answers from a 6-regex keyword table that *looks* identical on screen. |
   | `EXTRACTOR` | `bedrock` | The real document extractor. Under `demo` supplier/date/total are derived **from a hash of the filename** and marked Ready. |
   | `SMS_SENDER` | `email` | Chase sends go through the real compose path into the email seam + SMS outbox screen, instead of a silent demo row. |
   | `STATEMENT_READER` | `textract` | Real PDF/photo bank-statement OCR (D40's headline input). Requires the real-S3 block below — Textract cannot see MinIO. |

   **And replace the whole `--- S3 ---` block with real AWS.** Textract reads
   `S3_BUCKET_DOCUMENTS` directly from S3, so live-local stores documents in
   shared dev buckets (created 31 Aug 2026, 30-day object expiry, one set for
   the whole team) instead of MinIO. Empty endpoint/creds = the default
   credential chain, i.e. `AWS_PROFILE`:

   ```dotenv
   S3_ENDPOINT=
   S3_REGION=eu-west-2
   S3_ACCESS_KEY_ID=
   S3_SECRET_ACCESS_KEY=
   S3_FORCE_PATH_STYLE=false
   S3_BUCKET_DOCUMENTS=nt-dev-docs-252959251643
   S3_BUCKET_RECEIPTS=nt-dev-receipts-252959251643
   S3_BUCKET_EXPORTS=nt-dev-exports-252959251643
   ```

   Deliberately **left alone**:

   - `EMAIL_SENDER=demo` — no real mail leaves your laptop; sends land in the
     in-memory outbox.
   - `OTP_MODE=demo` — the fixed code `000000` everywhere (login TOTP + portal).
   - `BILLING=demo` — ⚠ a client created through intake has no subscription and
     its uploads **402**. Use the seeded clients, or run `BILLING=stripe` with a
     test key plus `stripe listen --forward-to localhost:3000/v1/webhooks/stripe`.
   - `DOCUMENT_GUARD=fixture` — flip to `qpdf` only if qpdf is installed
     (`winget install qpdf` / `brew install qpdf`).

3. **Database** (role creation is once per fresh Postgres volume):

   ```sh
   pnpm db:migrate && pnpm db:app-role && pnpm db:seed
   ```

4. **Run — two terminals.** `pnpm dev` starts api (:3000) + web (:5173) but
   **not** the queue worker, and without the worker uploads strand:

   ```sh
   pnpm dev
   pnpm --filter @neoting/api dev:worker
   ```

## Verify

1. `curl http://localhost:3000/healthz` → `{"status":"ok"}`.
2. Open http://localhost:5173 → log in `shakib@neoting.test` /
   `demo-neoting-2026` / TOTP `000000` (published demo fixtures, refused under
   `NODE_ENV=production`; `abdullah@neoting.test` is the Standard User).
3. Upload a real receipt image in Inboxes. It should move Processing →
   To Review with genuinely extracted fields — that one round trip proves
   MinIO, BullMQ, the worker and Bedrock end to end. A wrong supplier name
   read from a real image is live mode working; a plausible supplier derived
   from the filename means `EXTRACTOR` is still `demo`.
4. Ask the chat something free-form ("what's outstanding for American
   Burger?"). A conversational answer = Bedrock; a canned one-liner = demo.
5. **The D40 proof — upload a PDF bank statement.** Use the checked-in fixture
   `docs/runbooks/fixtures/meridian-statement-jul-2026.pdf` (a fictional bank,
   balance-consistent on purpose) on American Burger's Bank tab. Within ~a
   minute the Statements tab should show it with `assurance: complete`,
   `provenBy: balanceContinuity`, opening £4,520.00 / closing £4,348.65, and
   the Transactions tab should hold its 12 July lines, all UNMATCHED.
   That single round trip proves S3 → BullMQ → Textract → the statement parser
   → every D41 hard gate → persistence. (Verified 31 Aug 2026 with exactly
   this fixture.)

## Costs and safety

- Real cloud spend: roughly 1–2p per extraction/chat turn (capped by
  `AI_DAILY_BUDGET_PENCE`, £5/day per practice), and Textract at ~1.5p/page
  for tables (~35p for a 29-page statement).
- What still never leaves your machine: email (demo outbox), billing (demo),
  SMS (email seam). Cloud calls are Bedrock, Textract, and the dev S3 buckets.
- The dev buckets are shared by the whole team and expire objects after 30
  days — treat them as scratch, never as storage for anything real.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Login wall never appears / dev badge shows degraded | `AUTH_MODE` is not `session`, or the API isn't on :3000 |
| Uploads stuck in Processing | Worker not running, or `INGEST_QUEUE` not `bullmq` |
| Extraction "works" offline with weirdly confident fields | `EXTRACTOR` still `demo` (filename hash) |
| `AccessDeniedException` from Bedrock | Wrong profile/region — needs `bedrock:InvokeModel` in eu-west-2 |
| Upload returns 402 | Intake-created client with `BILLING=demo` — see above |
| Ingest job fails `NoSuchKey` right after upload | Seen once on a minutes-old bucket (read-after-write on fresh DNS); the job burns its 5 fast retries in ~18s. Retry the job or re-upload — it does not recur on a warm bucket |
| PDF statement refused "no transaction table" | The parser needs a header row with a date column and amount or paid-in/paid-out columns (`statement-parser.ts` lists the accepted names); real bank layouts match, an invented fixture may not |
| `GET /v1/statements` 500s (`listStatements` undefined) | You are on a commit before the explicit-`@Inject` fix in `statements.controller.ts` — pull main |
