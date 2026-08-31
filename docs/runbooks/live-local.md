# Live-mode local development

Run the real pipeline on your laptop — real Bedrock extraction and chat, real
queue, real object store — with hot reload instead of the ~15-minute staging
deploy. This is staging parity minus Textract and outbound email.

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
   docker compose up -d
   ```

2. **Create `.env`** — copy `.env.example` to `.env` if you don't have one,
   then set exactly these keys (leave everything else at its example value):

   | Key | Value | Why |
   |---|---|---|
   | `AWS_PROFILE` | `nt` | Not in `.env.example`. The AWS SDK credential chain reads it; Bedrock needs it. Skip if your default chain already resolves. |
   | `AUTH_MODE` | `session` | Real signed-cookie sessions — the web login wall cannot answer under `fixture`. |
   | `INGEST_QUEUE` | `bullmq` | Not in `.env.example`. Under the default `fixture` **no worker consumes uploads** — every document strands in Processing. |
   | `OBJECT_STORE` | `s3` | Not in `.env.example`. Stores bytes in MinIO (the `S3_*` values already point there). |
   | `IMAGE_NORMALISER` | `sharp` | Not in `.env.example`. Real image normalisation; sharp is a pnpm dependency, nothing to install. |
   | `AI_CHAT` | `bedrock` | The real chat model. Under `demo` the assistant answers from a 6-regex keyword table that *looks* identical on screen. |
   | `EXTRACTOR` | `bedrock` | The real document extractor. Under `demo` supplier/date/total are derived **from a hash of the filename** and marked Ready. |
   | `SMS_SENDER` | `email` | Chase sends go through the real compose path into the email seam + SMS outbox screen, instead of a silent demo row. |

   Deliberately **left alone**:

   - `STATEMENT_READER=none` — Textract reads `S3_BUCKET_DOCUMENTS` from real
     S3 and cannot see MinIO. CSV/XLSX statements import fine locally; PDF/photo
     statements are refused with a reason (test those on staging, or point the
     `S3_*` block at a real dev bucket).
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

## Costs and safety

- Real Bedrock spend: roughly 1–2p per extraction/chat turn, capped by
  `AI_DAILY_BUDGET_PENCE` (£5/day per practice by default).
- Everything stays on your machine: MinIO not S3, demo email, demo billing,
  no Textract, no Twilio. The only cloud calls are Bedrock model invocations.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Login wall never appears / dev badge shows degraded | `AUTH_MODE` is not `session`, or the API isn't on :3000 |
| Uploads stuck in Processing | Worker not running, or `INGEST_QUEUE` not `bullmq` |
| Extraction "works" offline with weirdly confident fields | `EXTRACTOR` still `demo` (filename hash) |
| `AccessDeniedException` from Bedrock | Wrong profile/region — needs `bedrock:InvokeModel` in eu-west-2 |
| Upload returns 402 | Intake-created client with `BILLING=demo` — see above |
| PDF statement refused | Correct behaviour: `STATEMENT_READER=none` locally (D41 — refuse, never silently skip) |
