# Neoting client demo — 21 Aug 2026, beat by beat

**METH Stage 14 deliverable.** This expands METH_MODE.md §6 into exact clicks, exact
utterances, exact files and per-beat fallbacks. §7 of METH_MODE.md is the single source for
the cast — this script repeats only what the presenter needs at speaking speed.

**The prime directive: the demo cannot fail twice.** Every beat has a fallback; the whole
demo has two (synthetic mode, then the recorded video). If a beat stumbles, use its fallback
and keep moving — never debug on stage.

---

## 0. Cast card (keep visible on a second screen)

| Thing | Value |
|---|---|
| Login | `shakib@neoting.test` / `demo-neoting-2026` / code `000000` |
| Portal OTP | `000000` |
| Star client | American Burger Ltd |
| Chase targets | Currys **£1,299.00** (9 Aug) · Google Ads **£600.00** (5 Aug) |
| Rule beat | "Whenever **Bidfood** invoices arrive for American Burger, code them **Cost of Sales Food** with standard VAT" |
| Publish failure | Anglian Water £98.40 (Harbourview Dental) — fails once, retry succeeds |
| MailHog | http://localhost:8025 · Web app: http://localhost:5173 · API: :3000 |

---

## 1. Laptop checklist (T-45 minutes)

### 1.1 The `.env` that actually demos

`.env.example` defaults will silently kill the login wall and both arrival beats. The demo
`.env` (repo root) must differ from the example in exactly these:

```
AUTH_MODE=session
EMAIL_SOURCE=mailhog
META_APP_SECRET=<any non-empty string — same process signs and verifies>
WHATSAPP_PRACTICE_MAP={"123456789012345":"prac_ledgerline"}
```

and must have non-empty values for `SESSION_SECRET`, `PORTAL_LINK_SECRET`,
`PORTAL_SESSION_SECRET`, `UPLOAD_URL_SECRET`. Confirm the demo adapters are selected (these
are the defaults, but look): `EXTRACTOR=demo`, `SMS_SENDER=demo`, `OTP_MODE=demo`,
`LEDGER_ADAPTER=demo`. Web side: `apps/web/.env.development` has `VITE_API_ENABLED=true`
(dev default — verify it was not flipped during a fallback drill).

### 1.2 Processes — four terminals, in this order

```
docker compose up -d                       # postgres :5433, redis, minio, mailhog
pnpm demo:reset                            # < 2 min — see §2
pnpm dev                                   # api :3000 + web :5173 (NOT the workers)
pnpm --filter @neoting/api dev:worker      # the document pipeline — without it nothing extracts
pnpm --filter @neoting/api worker:email    # the MailHog poller — without it the email beat is dead
```

`pnpm dev` does **not** start the workers. If a beat "hangs in Processing", the document
worker is down — that is the first thing to check, not the last.

### 1.3 Windows open before the client arrives

- Browser 1 (projector): http://localhost:5173 — logged **out**, ready for beat 1.
- Browser 2 (phone-sized, ~390×760): blank — this becomes "the client's phone" (beat 7).
- MailHog: http://localhost:8025 (beat 3 shows the actual email).
- Terminal with this script's commands ready to paste (§1.4).
- The fixtures folder on the desktop (§1.5).
- DevTools closed on the projector browser. Network: everything is local — demo works offline.

### 1.4 Commands the demo runs (paste-ready)

```
pnpm demo:whatsapp                 # beat 2 — receipt arrives by WhatsApp
pnpm demo:email                    # beat 3 — Google Ads invoice from the registered sender
pnpm demo:email -- --unregistered  # beat 3b — unknown sender → Unrouted
pnpm demo:portal-link              # beat 7 — prints the working portal URL for the newest chase
```

And the constitution demo (beat 5b) — approve-without-review, rejected server-side:

```
curl -s -c /tmp/nt.cookies -X POST localhost:3000/v1/auth/sessions \
  -H "content-type: application/json" \
  -d "{\"email\":\"shakib@neoting.test\",\"password\":\"demo-neoting-2026\",\"totp\":\"000000\"}"
curl -s -b /tmp/nt.cookies -X POST localhost:3000/v1/action-proposals/prop_chase_dental/approval \
  -H "content-type: application/json" -H "Idempotency-Key: demo-guard-2108" -d "{}"
```

The second call returns problem+json with an `NT-` code: the seeded proposal was never
read-reviewed, and the **database trigger** refuses the approve. Rehearse this once — it is
the single most important ten seconds of the demo.

### 1.5 The fixtures folder (build it now — the repo ships no image fixtures)

The DemoExtractor keys on **filename tokens**, not bytes. Take any small JPG/PDF and make
copies named exactly:

| File | Profile it triggers | Used in |
|---|---|---|
| `currys-receipt.jpg` | Currys £1,299 → READY | beat 4 (upload + duplicate) |
| `currys-receipt-phone.jpg` | Currys £1,299 → READY (**different bytes** from the one above, or dedupe fires mid-portal) | beat 7 (portal upload) |
| `shell-fuel-receipt.jpg` | Shell £72.50 → READY | beat 7b (wrong-doc mismatch) |
| `bidfood-invoice.pdf` | Bidfood £456.72 → READY | beat 8 (rule beat) |
| `lowconf-supplier.jpg` | Metro £89.40 → **TO_REVIEW** (VAT arithmetic fails) | beat 5 (fix a field) |
| `blurry-receipt.jpg` | extraction failure `NT-EXT-001` → **FAILED** | spare (honest-failure talking point) |

Keyword match is whole-token (`currys-receipt` hits `currys`; `shellfish` would not hit
`shell`). Any unlisted filename lands a deterministic generic profile — safe, but not scripted.

---

## 2. Reset — before each rehearsal and on the morning

```
pnpm demo:reset        # drop + migrate + seed v2, flush Redis, clear MinIO demo buckets
```

- Target < 2 min from cold. Restart the two workers afterwards if they were running (queued
  jobs were flushed under them).
- **Never run it while anyone else is working against the shared local DB** — it drops the
  world. On the demo laptop, that is exactly the point.
- After reset, verify the world in 60 seconds: log in → Inboxes shows the seeded cast (a
  duplicate pair, 2 failed, unrouted docs) → Clients → American Burger → Bank shows
  unmatched Currys £1,299 / Google £600 → Chases shows the mid-flight cast → Approvals shows
  one pending proposal.
- **Rehearsal acceptance (Stage 14): two clean consecutive full runs, one by each of us,
  from `pnpm demo:reset`.** Record the second one — that recording is the demo-of-last-resort.

---

## 3. The beats

Format per beat: **Do** (exact actions) · **Say** (the one line that lands) · **If it breaks**.

### Beat 1 — Login (the product has an identity)

**Do:** projector browser → `Sign in to Neoting` → email `shakib@neoting.test`, password
`demo-neoting-2026`, verification code `000000` → workspace opens; point at the context
header: signed-in user, acting role, client scope.
**Say:** "Nothing in this product changes state without a named human — you will watch the
server enforce that, not the UI."
**If it breaks:** login errors render their `NT-AUTH-*` code — read it out loud, it is a
feature ("even our failures carry stable codes"). API down → the app degrades to the
designed synthetic workspace with a visible badge; continue the walkthrough there and demo
beats from the fixtures (the §5 fallback path).

### Beat 2 — A receipt arrives by WhatsApp

**Do:** terminal → `pnpm demo:whatsapp` → Inboxes. Expected: the Currys receipt arrives for
American Burger (registered sender `+447700900001`) and runs Processing → Ready live
(2–4 s). If it lands in the **Unrouted** strip instead, that is a beat, not a bug: route it
to American Burger / Costs with one click — the route is itself a Review → Approve proposal.
**Say:** "A real webhook, HMAC-verified, straight into the same pipeline as everything else."
**If it breaks:** the webhook 401s → `META_APP_SECRET` mismatch (env checklist §1.1); job
dead-letters → `WHATSAPP_PRACTICE_MAP` unset. Fallback: skip to beat 4's drag-drop — same
pipeline, same story, different door.

### Beat 3 — Email in, routed by sender identity

**Do:** `pnpm demo:email` → show MailHog (:8025) — the actual email, Google Ads invoice
£600 → Inboxes: routed to American Burger because `owner@americanburger.test` is a
registered sender. Then `pnpm demo:email -- --unregistered` → lands in **Unrouted** →
one-click route through Review → Approve.
**Say:** "Known senders route themselves. Unknown senders wait for a human — never a guess."
**If it breaks:** nothing arrives → the email poller isn't running (§1.2). Fallback: MailHog
still shows the email (the story survives); route the WhatsApp doc instead for the Unrouted
moment.

### Beat 4 — Drag-drop, live pipeline, duplicate caught

**Do:** Inboxes → set the client filter to **American Burger** (the upload refuses without a
named workspace — by design, say so) → drag `currys-receipt.jpg` onto the view → watch
Processing → Ready live → open it: original image, per-field confidence colouring,
provenance per field, events timeline. Then drag **the same file again** → duplicate flag →
open the side-by-side compare.
**Say:** "Byte-identical or near-identical — it never silently becomes two costs."
**If it breaks:** stuck in Processing → document worker down (§1.2). Duplicate not flagged →
you used two different files; use literally the same file. (The compare's resolution buttons
are informational in this build — the executor ships post-demo; don't promise them.)

### Beat 5 — Fix a field, and the constitution

**Do:** drag `lowconf-supplier.jpg` in → it lands **To Review** (low confidence + VAT
arithmetic validator failed — show the reason). Open it → correct the category → the
Review → Approve card stages → open Read review → Approve → the field's provenance flips to
human-confirmed.
**5b:** terminal → the two curl commands (§1.4) → show the problem+json refusal.
**Say:** "Approve without review is rejected by a database trigger. Not our UI being polite —
the server refusing."
**If it breaks:** the proposal card renders its `NT-` code — read it, retry once. Curl beat:
rehearse the two commands the morning of; if the seeded proposal id changed, pick any
pending proposal id from the Approvals screen.

### Beat 6 — Bank, and the chase composed by chat

**Do:** Clients → American Burger Ltd → **Bank** tab → the feed: unmatched **Currys
£1,299 (9 Aug)** and **Google £600 (5 Aug)**; point out the suppressed noise
(`STRIPE PAYOUT`, `SERVICE CHARGE` never become chases). Sidebar → **AI Workspace** → type
(or dictate): **"Chase American Burger for the missing receipts"** → composer card lists the
two transactions → stage → Read review shows the SMS **verbatim** → Approve → sidebar →
**Chases**: chase ACTIVE, and the **SMS outbox** panel ("the client's phone") holds the
exact SMS that was reviewed.
**Say:** "What you approved is byte-for-byte what was sent. Review is not a summary."
**If it breaks:** utterance not recognised → the intent table is tolerant, but the graceful
"here's what I can do" card appears — click through to the same composer. Chat entirely
down → Chases view: the detection list is the same data; narrate composition from the
outbox's seeded history.

### Beat 7 — The portal: no app, a phone, an OTP

**Do:** terminal → `pnpm demo:portal-link` → copy the printed URL into the **phone-sized
window** → OTP `000000` → the chased items (Currys £1,299) → Upload File →
`currys-receipt-phone.jpg` → extraction overlay (fields editable) → submit → success — and
on the projector: the chase **auto-closes**, the accountant gets the notification, the
document is in American Burger's inbox marked as uploaded by a delegated session.
**7b (optional, strong):** run `pnpm demo:portal-link` again for another open chase — or
reuse the session — and upload `shell-fuel-receipt.jpg`: the portal names the mismatch ("this
looks like £72.50 — we need the £1,299 Currys transaction") and the chase stays open.
**Say:** "The client installed nothing. The link grants nothing without the OTP, and the
session can see exactly the items it was sent for — row-level security, not UI hiding."
**Why the command, honestly:** the outbox SMS does not yet carry a working link — the chase
id is minted at approval, after composition signs the token (known gap, tracked in the chase
module; the fix is an engine-side compose seam). `demo:portal-link` signs the same token the
product will, for the real chase. If the client asks: "the link in the SMS is being wired to
the approval step this sprint" — true.
**If it breaks:** OTP rejected → `OTP_MODE=demo` unset. Upload stuck → worker (§1.2). Total
failure → beat 4 already proved ingestion; narrate the portal over the designed portal UI in
synthetic mode.

### Beat 8 — The rule beat (the wow)

**Do:** AI Workspace → type/dictate: **"Whenever Bidfood invoices arrive for American
Burger, code them Cost of Sales Food with standard VAT"** → rule card (fields, tier, scope) →
Read review → Approve → now drag `bidfood-invoice.pdf` into American Burger's inbox → open
it: **already coded Cost of Sales Food, provenance = the rule you just made**, not AI.
**Say:** "You taught it in one sentence, through the same approval gate as everything else —
and the next invoice obeyed."
**If it breaks:** rule card doesn't stage → check the Approvals queue: if the proposal
exists, approve it there (same engine). The seeded rule (Coca-Cola → Cost of Sales — Drink)
is the backup narrative: show it in the extractor's provenance instead. **Never seed a
Bidfood rule to "fix" this beat — it deletes the wow.**

### Beat 9 — Publish to "Xero", one honest failure

**Do:** AI Workspace → **"Publish all approved costs to Xero"** → preview card → Read
review shows **server-computed** totals (count, gross, VAT) → Approve → per-item results:
`XERO-INV-####` refs, documents locked + archived — and **one failure**: Anglian Water
£98.40 lands in **Inboxes → Failed** with Xero's reason → click Retry → new proposal →
approve → green.
**Say:** "The failure is the feature: nothing silently drops. Rejected keeps its reason and
its retry."
**If it breaks:** the utterance path fails → Approvals view: create/approve the publish
proposal from the queue. The retry succeeding is deterministic — if the first attempt
didn't fail, the seed is stale: you skipped `pnpm demo:reset`.

### Beat 10 — Breadth, then the close

**Do:** fast tour, presented as designed surfaces in build: Clients (health, deadlines) →
Analytics → Approvals → Workflows tab (the builder) → Team → Settings (the 18 panels) →
Documents → Vault.
**Say (the close):** "Everything you watched change state went through Review → Approve,
server-enforced. The seams for the real vendors — Textract, Twilio, TrueLayer, Xero — are
already in the code; today's demo adapters sit behind the same interfaces the production
ones will."

---

## 4. What NOT to click (known gaps, all tracked)

- **SMS outbox "Open the secure link"** — seeded SMS carry a placeholder path; chat-created
  chases carry none. Beat 7 enters via `pnpm demo:portal-link` (see beat 7's honest note).
- **Duplicate compare resolution buttons** — informational note in live mode; detection is
  the demo, resolution ships post-demo.
- **Bank → Matches tab** — live it explains where matches live (the transaction rows);
  don't linger there.
- Local-only bulk actions (publish/delete/move/mark-reviewed from tables) are hidden or
  disabled-with-tooltip in live mode as of Stage 14 — the tooltips point at the real paths;
  reading one aloud is fine if a hand strays.

---

## 5. Failure ladders (rehearse both)

1. **A wired screen degrades mid-demo** → it falls back to the designed synthetic surface
   with a dev badge (per-slice fallback, METH Stage 6). Name it honestly ("this surface just
   dropped to sample data — the rest is still live") and keep going.
2. **The API/backend is unusable** → `apps/web/.env.development`: set `VITE_API_ENABLED=false`,
   restart `pnpm dev` → the entire app runs the synthetic walkthrough (no login wall). This
   demos cleanly end-to-end; the script's beats all have designed-surface equivalents.
3. **The laptop is unusable** → the recorded run-through from the rehearsal on the 20th
   (record it — that is Stage 14's acceptance, not an optional extra).

---

*Stage 14, 19 Aug 2026. After the 21st this script expires with METH_MODE.md — the demo
mocks become tracked issues, client feedback lands in the Source of Truth first.*
