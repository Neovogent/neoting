# ADR 0008 — S3 encryption topology: request-time gating, not per-workspace keys

**Status:** Accepted · **Date:** 13 August 2026 · **Decider:** Shakib (eng)
**Corrects:** Source of Truth §15 (tenancy model), Engineering Governance §5.2, §18 · **Preserves:** D11, D30

---

## Context

Both source-of-truth files described the S3 tenancy control as *"workspace-prefixed keys under a **per-workspace KMS encryption context**"*. That phrase was written as a design intention and survived into two documents that customers, auditors and the DPIA will be shown.

It is not achievable. Three independent reasons, any one of which is sufficient:

**1. S3 SSE-KMS does not accept a caller-supplied encryption context.** S3 sets the encryption context itself: `{"aws:s3:arn": "<object ARN>"}` for a normal SSE-KMS object, and the *bucket* ARN when S3 Bucket Keys are enabled. There is no `PutObject` parameter that overrides it. The encryption context is therefore already determined by the object's own path — it cannot be made to carry a workspace identity we choose.

**2. A KMS key per workspace does not scale.** Customer-managed keys are billed per key per month before a single API call. A practice with thirty client businesses is thirty keys; ten pilot practices is three hundred; the pilot's own target is ten practices and the product's shape is many more. That is a recurring cost that grows linearly with the thing we most want to grow, plus a key-policy surface that has to be edited every time a membership changes — and key policies have a hard size limit, so "add every authorised principal to the key policy" has a ceiling as well as a maintenance cost.

**3. Client-side encryption would break the extraction path.** The only way to get a genuinely arbitrary per-workspace encryption context is the S3 Encryption Client, encrypting before upload. Textract's asynchronous API reads objects **from S3 directly** — it can decrypt SSE-KMS given key permissions, but it cannot decrypt a payload we encrypted client-side, because it never sees our data key. The async path is precisely the one that handles bank statements up to 300 pages (SoT Stage 2). Choosing client-side encryption means choosing to lose the 300-page statement flow.

## Decision

**Per-environment CMK, workspace-prefixed keys, and access gated at request time.**

| Layer | Control |
|---|---|
| Key | One customer-managed CMK per environment. Bucket and key policies carry an **explicit Deny** for any principal outside `role/nt-*` (D36's compensating control). |
| Path | Object keys are workspace-prefixed: `w/<businessId>/…` |
| IAM | The task role's object permissions are scoped to `<bucket>/w/*`, and `s3:ListBucket` carries an `s3:prefix` condition so a listing with no prefix is denied. This bounds the **namespace**, not the tenant — see below. |
| Application | RLS-scoped services (`scopedDb(ctx)`, Governance §5.2) decide which key a caller may name **at all**. A caller who cannot read the document row cannot learn the S3 key that belongs to it. |
| Delivery | Item-scoped presigned URLs, minutes-long, one object each. A delegated OTP session's URLs cover exactly the items its chase granted. |

### What the IAM layer does and does not buy

Be precise about this, because it is easy to overclaim in a security questionnaire. **One task role serves every workspace.** It therefore cannot be scoped to a single `businessId` — the role legitimately needs to reach every tenant's prefix, and no IAM condition can distinguish "this request is on behalf of American Burger" from "this one is not". Per-tenant scoping lives in the application: RLS decides which S3 key a caller may learn at all, and presigned URLs are issued per item.

What IAM contributes is a **namespace bound**: object actions are limited to `<bucket>/w/*`, and `s3:ListBucket` requires an `s3:prefix` inside a known namespace, so an unprefixed "list the whole bucket" is denied. That bounds the blast radius of a compromised task and of a key-construction bug. It is a real layer. It is not tenant isolation, and saying otherwise would be the same category of error this ADR exists to correct.

### Why this is the stronger control anyway

Key-level separation answers "could this ciphertext be decrypted by the wrong tenant's key". Request-time gating answers "can the wrong tenant cause a decryption to be attempted at all" — and denies first. A request that never reaches S3 is a better outcome than a request that reaches S3 and fails a key-policy check, because the second one is one policy edit away from succeeding and the first is four independent layers away.

It is also the control that is actually **tested**. The CI tenancy suite (Governance §15.4) attempts real cross-practice, cross-client and delegated-session-overreach access with real tokens and requires all of them to fail. There is no equivalent test that meaningfully exercises a per-workspace key boundary, because the boundary would sit below the layer where the attack happens.

### The honest limit, stated so nobody has to rediscover it

**This is not key-level separation, and it must never be described as such** — not to a customer, not to an auditor, not in the DPIA, not in a security questionnaire answer. Every Neoting object in an environment is encrypted under one CMK. A principal holding both `kms:Decrypt` on that key and unconditioned `s3:GetObject` could read across workspaces. What prevents that is IAM conditions and the application layer, not cryptography.

The accurate sentence is: *"Documents are encrypted at rest with a customer-managed KMS key per environment. Cross-tenant access is prevented by row-level security in the database, IAM prefix conditions on the compute role, and item-scoped short-lived URLs — enforced below the application layer and continuously tested in CI."*

## Consequences

1. **Both source-of-truth files were amended** in the v1.4 pass — SoT §15 and §18, Governance §5.2 — to describe request-time gating rather than key-level separation. This ADR is the record of why, and is cited from both.
2. **The DPIA and any security questionnaire inherit the wording above**, not the original phrase. Combined with D36 (shared AWS account), the honest DPIA position is: single-tenant-per-environment key, shared account, compensating IAM and application controls, all Terraform-defined.
3. **S3 Bucket Keys are enabled, and this decision is why they safely can be.** `bucket_key_enabled` is already set on the KMS-encrypted buckets (`main.tf`), cutting KMS request charges by up to ~99% on a read-heavy document store. Bucket Keys change the encryption context from the *object* ARN to the *bucket* ARN — a coarsening that would matter to anyone relying on per-object context, and which is free to us precisely because this decision established that we never were.
4. **The prefix condition is load-bearing and must be tested.** An IAM policy granting `s3:GetObject` on `arn:aws:s3:::nt-*-documents/*` without a prefix condition silently removes one of the four layers. Any change to the task role's S3 statements needs the tenancy suite run against it.
5. **If a customer ever contractually requires key-level separation**, the answer is a dedicated environment (own account, own CMK, own buckets) — priced accordingly — not a per-workspace key inside a shared one. Terraform makes that a variable change (D36, `infra/README.md`).
6. **Revisit if S3 ever supports caller-supplied encryption context**, or if Textract gains a client-side-decryption path. Neither is on any published roadmap; this is a note for the re-reader in a year, not an expectation.

## Follow-ups

- [ ] Confirm the KMS request-charge drop from Bucket Keys once document volume exists (consequence 3) — it is enabled, but unmeasured at zero traffic.
- [ ] Add an explicit tenancy-suite case for the S3 prefix condition, not only the database policies (consequence 4).
- [ ] The `receipts` bucket defaults to AES256, not the CMK, for the SES reason recorded in `main.tf` and ADR 0002. Inbound objects still land SSE-KMS because the key is named on the SES action — but a future writer to that bucket who does **not** name the key gets AES256 silently. Any new writer needs a bucket policy condition requiring `aws:kms`, or the exception spreads.
- [ ] When the DPIA is drafted, lift the wording from this ADR verbatim rather than paraphrasing it.
