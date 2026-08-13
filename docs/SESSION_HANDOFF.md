# Session handoff — 13 August 2026 (Sprint 1, Day 1)

Written so a fresh session can pick up without re-deriving anything. Read this, then `CLAUDE.md`, then the source-of-truth pair.

---

## 1. Where the project is

| Measure | Done | Basis |
|---|---|---|
| **v1 overall (W0–W14 to pilot)** | **~7%** | Infrastructure and one of four Sprint-0 contracts. None of the 11 pipeline stages exist yet. |
| **W0 kickoff checklist** | **~60%** | AWS section essentially complete; external clocks running; build inputs mostly outstanding. |
| **Sprint Day-1 target (S0)** | **~55%** | Scaffold, CI, compose, schema, seed done. Three contracts outstanding. |
| **Shakib's own tracks (S0–S4)** | **~30%** | S3 infra ~85%, S0 ~55%, S1 ~15%, S2 ~10%, S4 0%. |

**Honest read:** infrastructure ran *ahead* of the plan (S3 was scheduled D2–D4, finished D1). The contracts are now the critical path, and they gate three other people.

---

## 2. Environment facts a new session needs

```
AWS account      252959251643  (alias neovotech) — SHARED with 3 other Neovogent products
AWS profile      nt            (IAM user "Mubashir", admin) — set AWS_PROFILE=nt
Region           eu-west-2 only
GitHub           github.com/Neovogent/neoting
Legal entity     NEOVOGENT AI SOLUTIONS UK LTD — company 15946429
AWS budget       $8,000 across 6 months (staging ~$150/mo)
```

**Tool paths (not on PATH in agent shells):**
```
docker      C:\Program Files\Docker\Docker\resources\bin\docker.exe
            ^ add that dir to PATH or the credential helper fails
aws         C:\Program Files\Amazon\AWSCLIV2\aws.exe
terraform   C:\Users\shaki\AppData\Local\Microsoft\WinGet\Packages\Hashicorp.Terraform_*\terraform.exe
git         C:\Program Files\Git\cmd\git.exe   (missing from cmd's PATH)
```

**Local stack:**
```bash
docker compose up -d        # postgres:5433 (NOT 5432), redis:6379, minio:9000, mailhog:8025
pnpm install
pnpm db:seed                # 40 documents, 3 clients
pnpm db:tenancy-check       # 18 assertions, non-destructive
```

---

## 3. Gotchas already paid for — do not rediscover these

1. **Host Postgres is 5433.** A native Postgres occupies 5432 on this machine; binding it sends the app to the wrong database and surfaces as an *authentication* error.
2. **`prisma migrate dev` hangs** in a non-interactive shell. Use `migrate deploy`. If a run is killed, it leaves an advisory lock — clear with `pg_terminate_backend` on the idle session.
3. **Prisma CLI must run from the repo root** (it resolves the workspace root as the project and will try to `pnpm add` there). CLI and client are declared in the root `package.json` for this reason.
4. **RLS must be appended to the migration *before* it is applied**, or tables exist without policies and the first seed writes unprotected rows. See `prisma/CLAUDE.md`.
5. **Postgres bypasses RLS for the table owner** — hence `FORCE ROW LEVEL SECURITY` and the `nt_app` non-owner role. Get this wrong and every policy is decorative.
6. **`businesses` policy is written longhand on purpose.** Calling the shared predicate there recurses to the stack limit.
7. **Bedrock: no `eu.*` inference-profile ARNs are granted.** In-region on-demand models only, so a cross-region call fails closed (D30).
8. **The SES receipts bucket is AES256, not KMS.** SES validates a receipt rule by test-writing, and that write fails against a customer-managed-key *default*; inbound mail is still encrypted with the CMK named on the SES action.
9. **`now()` is stable within a transaction** — that is why the execute-once guard checks for presence, not for a changed value.

---

## 4. What is done

**Merged to `main` (PR #1):**
- AWS staging foundation: org guardrail IAM policy (SCPs unavailable — consolidated-billing org), KMS + 3 isolated buckets with explicit Deny, GitHub OIDC roles, CloudTrail, GuardDuty, budgets with credits excluded
- VPC (3 AZ, no NAT), RDS Postgres 16.14 (PITR 35d), ElastiCache Redis 7.1, ECS cluster + 3 ECR repos
- SES: DKIM verified, custom MAIL FROM, DMARC, inbound `doc@neoting.neovogent.com` → S3 with virus/spam scanning
- Route 53 zone delegated from Cloudflare and resolving
- `docs/AWS_Foundation_Runbook.md`, `docs/adr/0001-bedrock-model-tiers-uk-residency.md`
- Source-of-truth pair amended to **v1.4** (D34 entity, D35 spend, D36 shared account; D28 model IDs; D30 fallback retired)

**On branch `chore/repo-monorepo-scaffold` (4 commits, not yet pushed/merged):**
| Commit | Contents |
|---|---|
| `4755439` | pnpm + Turborepo monorepo, Docker Compose, thin CI, CODEOWNERS, PR template, root + 16 module `CLAUDE.md` |
| `5eb5be3` | `prisma/schema.prisma` (~35 models) + `prisma/sql/rls.sql` |
| `b8e476f` | Migration applied, 362 columns snake_cased, 18/18 tenancy assertions passing |
| `cd31f58` | Seed: 40 documents across all 7 states, 26 bank lines, 3 chases, 2 proposals |

**Verifications closed:** 8.1 (Bedrock in-region), 8.2 (SES inbound in eu-west-2 — the eu-west-1 fallback is retired), 8.3 (effort params).

---

## 5. What is next, in order

### Immediate (Shakib)
1. **Push and open the PR** for `chore/repo-monorepo-scaffold`.
2. **OpenAPI spec** — `packages/contracts`. **This is the critical path**: it blocks Abdullah's endpoints, and the frontend's typed client and MSW mocks. Start with the ingestion + documents surface; every shape now derives from the applied schema.
3. **Design tokens** and **chat component grammar** — the other two Sprint-0 contracts. Both must carry the §13.3 obligations (provenance classes visible by default, trace expansion, persistent context header).
4. **S1 auth-tenancy**: `scopedDb`, the GUC pattern, the ActionProposal engine, audit service.

### Decisions only Shakib can make
- **How provisioning runs under RLS.** `app_can_access_business()` needs a membership that does not exist until provisioning creates it. Options: a narrow `SECURITY DEFINER` function, or a separate privileged connection used *only* by that path. Do not solve it by loosening a policy. Blocks S1.
- **Per-family inference parameters** in `models.ts` — Nova and Claude take different shapes; Opus 4.8 rejects `temperature` outright. Blocks S2.
- **Money width**: `Int` pence caps a column at £21,474,836.47. Cheap to change now, painful after data exists.

### Delegated / in flight
- **Abdullah** — briefed, working on the ingestion sanitisation pipeline (pure library, no API surface, Governance §11.4 order). Next: B1 endpoints once the OpenAPI spec freezes. Told to build the WhatsApp webhook against the **real Meta sandbox**, not a simulator.
- **Frontend team** — reportedly almost done, will bring an existing app into `apps/web`. **Conversation deferred by Shakib.** Three questions decide import-vs-rebuild: does every state change already go through a two-step review; is styling tokens or hex; are strings through next-intl. Also: get their list of API calls *before* freezing the OpenAPI spec.

### Waiting on other people
| Item | Owner | Note |
|---|---|---|
| ICO registration | Rakib vai (CEO) | Blocks pilot; ~15 min, £40–60 |
| Cloudvisor: dedicated `neoting-*` accounts + ALL_FEATURES + which entity holds the AWS DPA | Shakib to chase | Until then the DPIA must say "shared account" |
| SES production access | AWS | Submitted, ~24h |
| Textract quota 1→10 TPS | AWS | Submitted |
| Twilio UK sender registration | Shakib | In progress |
| Meta business verification | Shakib | In progress; sandbox already usable |
| Pen test booking | Ops | Must be booked by **W8** |

---

## 6. Working agreements in force

- Branch `type/area-short-desc`, issue first, draft PR from first push, PR title must be a valid conventional commit (squash takes it), target < 400 lines.
- Review chain: Abdullah → Shakib · Moyen → Shamim · Shamim → Moyen/Shakib · Shakib → Abdullah. **Sprint SLA 4 working hours.**
- LAW paths (`packages/contracts`, `component-grammar`, `tokens`, `validators`, `prisma/`) change only via a contract-change issue approved by Shakib **before** the PR opens.
- R1–R16 are instant rejects (Guideline §6). Money as float, unscoped Prisma query, and state change bypassing ActionProposal are the three that matter most.
- Synthetic data only, everywhere, until ICO + DPIA are done.
