<!--
TITLE: the squash commit takes it (G4), so it must be a valid conventional
commit — and the subject must be entirely LOWER-CASE, identifiers included.

Check it before you open the PR, in one second:

    pnpm pr:title "feat(api): the thing you did"

These four all failed CI on that one rule, and all four were an identifier that
is correctly capitalised everywhere else in the codebase:

    feat(contracts): add NT-SRV-001 error code            ✗
    feat(api): wire IngestQueue and DLQ                   ✗
    feat(api): add scopedDb and anchor unrouted documents ✗
    feat(ingest): object storage … (S3/MinIO)             ✗

Identifiers, error codes and product names belong in the body, where their real
casing survives. The title is prose.
-->

## What
One sentence. Closes #___

## Why
The problem this solves, in the product's terms.

## How verified
- [ ] typecheck / lint / unit green locally
- [ ] Tests added/updated for changed logic
- [ ] UI: preview link + phone screenshots (light+dark, states) below
- [ ] API: request/response sample or test evidence below
- [ ] Module CLAUDE.md updated (backend) / i18n keys added, no literals (frontend)

## Contract change?
- [ ] No
- [ ] Yes — approved contract-change issue: #___

## Screenshots / evidence
(paste here)

---
<!--
Before requesting review, read your own diff line by line — half of all review
comments die there. The bar is Guideline §6: if none of R1–R16 fire and the
Definition of Done holds, this merges. The PR title must be a valid conventional
commit, because the squash commit takes it.
-->
