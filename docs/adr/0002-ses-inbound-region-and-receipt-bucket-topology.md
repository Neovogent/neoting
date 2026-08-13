# ADR 0002 — SES inbound receiving region and receipt-bucket topology

**Status:** Accepted · **Date:** 13 August 2026 · **Decider:** Shakib (eng)
**Closes:** Kickoff verification 8.2 · **Amends:** D30 (retires one of its two named exceptions) · **Implements:** D5, SoT §4 Stage 1

---

## Context

`doc@neoting.neovogent.com` is the single platform intake address — one address for every client, employee and supplier, with routing decided server-side (SoT Stage 1). It is a load-bearing channel, not a convenience: two of the five ingest channels reach the pipeline through it.

D30 requires all storage and processing in eu-west-2 (London), and named exactly two exceptions where no UK option was believed to exist. One was **SES inbound receiving in eu-west-1**, conditional on W0 verification 8.2 — the concern being that SES email receiving has historically been offered in a narrower set of regions than SES sending, and London might not be among them.

That exception was written as a contingency, not a plan. If it had been needed, every inbound customer document would have transited Ireland before reaching a London bucket, and the DPIA would have had to say so.

## Verification (13 August 2026)

**SES inbound receiving is available in eu-west-2.** A receipt rule set was created, activated and successfully tested in London: `nt-staging-inbound`, with rule `doc-to-s3` matching `doc@neoting.neovogent.com`, `scan_enabled = true`, `tls_policy = "Require"`, writing to `nt-staging-receipts-252959251643` under prefix `inbound/`. The MX record `10 inbound-smtp.eu-west-2.amazonaws.com` resolves and accepts mail.

## Decision

**1. Inbound receiving stays in eu-west-2. The eu-west-1 fallback is retired unused.**

The entire email path — MX, receipt rule, spam and virus scanning, receipt bucket, ingestion — is in London. D30's exception list drops from two to one, leaving only the cross-region DR backup target (ADR 0007), which survives for the unavoidable reason that the UK has a single AWS region.

This is worth naming plainly because it is the rare case where a residency promise got *stronger* during implementation rather than eroding under delivery pressure.

**2. The receipts bucket defaults to `AES256`, not the CMK — and inbound mail is still CMK-encrypted.**

This looks like a contradiction and is not, so the mechanism is recorded here rather than left as a surprise in `main.tf`.

SES validates a receipt rule at *creation* time by test-writing to the destination bucket. When the bucket's default encryption is a customer-managed KMS key, that validation write fails with `InvalidS3Configuration: Kms key is not available` — **regardless of how the key policy is written**. Verified empirically on 13 Aug 2026 against a key policy that explicitly granted `ses.amazonaws.com` the necessary `kms:GenerateDataKey` and `kms:Encrypt` with the correct `aws:SourceAccount` condition. The failure is in SES's validation path, not in our permissions.

The resolution keeps the encryption and drops only the *default*:

| Layer | Setting | Effect |
|---|---|---|
| Bucket default encryption | `AES256` | SES rule validation succeeds |
| `s3_action.kms_key_arn` on the receipt rule | `aws_kms_key.docs.arn` | Every inbound object is written **SSE-KMS under `alias/nt-staging-docs`** |

So objects land encrypted with our CMK exactly as intended. What changed is which layer names the key: the action, not the bucket.

## Consequences

1. **D30 now has one exception, not two.** Both source-of-truth files were amended in the v1.4 pass. Anyone quoting the residency position should say "all processing in London; one named exception, the DR backup target" — not "two".

2. **The receipts bucket carries a real latent risk, and it is not theoretical.** Its default is AES256. Today the only writer is SES, which names the key. **A future writer that does not name the key will silently produce AES256 objects in a bucket whose data class is `customer-document`** — no error, no alarm, just a quieter encryption story than the one we describe to auditors. Mitigation, which should land before any second writer exists: a bucket policy `Deny` on `s3:PutObject` where `s3:x-amz-server-side-encryption != aws:kms`. That inverts the failure from silent to loud.

3. **`scan_enabled = true` is the first line of the sanitisation pipeline, not a substitute for it.** SES gives spam and virus verdicts before we touch the payload, which is genuinely useful — but Governance §11.4 still requires the full local pipeline (magic-byte sniffing, extension allowlist, size cap, ClamAV, PDF flattening, ZIP depth caps). SES's verdict is one signal, and it is the *sender's* claim about the attachment, not ours.

4. **Email bodies and attachments arriving here are untrusted content.** They reach a model only inside `<untrusted_content>` (Governance §9.6). This channel is the single most likely prompt-injection vector in the product, because anyone in the world can send to `doc@`. The adversarial corpus must include realistic email-borne payloads, not only document-borne ones.

5. **Production access is a separate clock, and it is waiting on us.** The SES sandbox restricts *outbound* only; inbound receiving works regardless, so ingest is unblocked today. Outbound — onboarding invites, supplier statement-gap chases, notifications — waits on case **178662887400793**, submitted 13 Aug.

   Read the API status carefully. `sesv2 get-account` reports `ReviewDetails.Status = "DENIED"`, which looks final and is not: the support case is **"Pending customer action"**, because AWS replied within the hour asking for more detail on sending processes, bounce and complaint handling, and how recipient lists are maintained. SES marks access denied while it waits for the answer. Anyone reading only the API would conclude the request was refused and that there is nothing to do; the truth is the opposite — there is exactly one thing to do, and no clock runs down on its own until it is done.

6. **Both `doc@` domains must route identically through the D5 cutover.** Today only `neoting.neovogent.com` exists. When `neoting.com` is acquired, it needs its own identity, DKIM, MAIL FROM, DMARC and MX, plus a receipt rule matching `doc@neoting.com` in the same rule set — a rule set can hold both. Rehearse in staging; a cutover that drops inbound mail loses customer documents, and the sender gets a bounce for a document they will assume arrived.

7. **DMARC is at `p=none` deliberately.** Alignment is being watched, not enforced. Tighten to `p=quarantine` before the pilot, and add `rua=` only once `support@` exists — a reporting address that bounces is worse than no reporting address.

## Follow-ups

- [ ] Add the `Deny` on non-KMS `PutObject` to the receipts bucket policy (consequence 2) — the highest-value item here, **but test it against SES first**. The condition keys off the `s3:x-amz-server-side-encryption` request header, and it is not established that SES sends that header when it encrypts via the key named on the receipt action rather than via a bucket default. If it does not, the Deny silently blocks all inbound mail — and the failure surfaces as customer documents that never arrive, which is the worst possible way to learn it. Verify in staging with a real send before this goes anywhere near production.
- [ ] Add email-borne prompt-injection cases to the adversarial corpus (consequence 4).
- [ ] Tighten DMARC to `p=quarantine` and add `rua=` when `support@` is live (consequence 7).
- [ ] Rehearse the two-domain cutover in staging before `neoting.com` goes live (consequence 6).
- [ ] Confirm SES production access granted; until then, no outbound path is demoable end to end.
