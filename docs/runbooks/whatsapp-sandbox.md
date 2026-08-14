# Runbook — WhatsApp Cloud API sandbox

**Status:** current as of 14 Aug 2026 · **Owner:** Shakib · **Related:** SoT D25 (inbound-only), Governance §11.7 (webhook HMAC), issue #9

What it took to get a real WhatsApp message from a phone into `IngestQueue`, and
the four things that wasted the most time. Read this before touching the Meta
dashboard again.

## What the sandbox is for

D25: **we never send on WhatsApp.** Twilio owns all chasing over SMS. WhatsApp is
an inbound document channel and nothing else. So:

- Do **not** add a payment method. It buys business-initiated messaging, which we
  have decided not to use. Replies inside the 24-hour service window are free.
- Do **not** work through "Register your phone number" / "Send message" in the
  use-case wizard. Those are outbound production flows.
- The only field we subscribe to is `messages`. The other 33 are status
  callbacks, template updates and group events we do not consume.

## The identifiers

| Thing | Value |
|---|---|
| App | `Neoting` — `1356819946087512` |
| Test number | +1 555 670-1041 |
| Test number Phone Number ID | `1313642638490876` |
| Test WABA | `1619404743136179` |
| Endpoint | `POST /webhooks/whatsapp` (+ `GET` for the handshake) |

Two secrets, and they are **different things** — `META_APP_SECRET` keys the POST
HMAC, `META_VERIFY_TOKEN` is a string we invent for Meta's GET handshake. Both
live in `.env` locally and in Secrets Manager (`/neoting/staging/whatsapp`) for
deployed tasks. Empty means **fail closed**, not "verification off": POST 401,
GET 403.

## Trap 1 — subscription has TWO layers, and saving the callback is neither

This is the one that cost the afternoon. A saved, verified callback URL delivers
**nothing** on its own. Both of these must also be true:

1. **The app must be subscribed to the WABA.** Check it:

   ```bash
   curl -s "https://graph.facebook.com/v25.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <TOKEN>"
   ```

   A fresh test WABA comes back subscribed to `WA DevX Webhook Events 1P App`
   (`2202427980234937`) — that is **Meta's own** app, the one that populates the
   "Check test webhooks" panel in the dashboard. Seeing rows in that panel is
   therefore *not* evidence that anything reaches us. Subscribe our app with the
   same URL and `-X POST`.

2. **The `messages` field must be subscribed** in the app's webhook config. The
   fields table shows `Unsubscribed` by default for all 34 fields. Verify by
   *looking at the table*, not by remembering having clicked it.

Each WABA is subscribed separately — subscribing the test WABA does nothing for a
production WABA.

## Trap 2 — the "publish your app" banner is a red herring

The dashboard warns that an unpublished app receives only dashboard-sent test
webhooks, "including from app admins, developers or testers". It is prominent,
plausible, and it was **not** why delivery failed — Trap 1 was. Real inbound
messages reach an unpublished app fine once both subscriptions exist.

Do not start publishing (privacy policy URL, App Review) to fix a delivery
problem until `subscribed_apps` and the fields table have both been *seen* to be
correct.

## Trap 3 — the API logs in London, the laptop runs on Dhaka time

`.env` sets `TZ=Europe/London`, correctly, per the UTC-storage /
Europe-London-rendering invariant. The dev machine is `Asia/Dhaka`. So a message
sent at **18:08** on the phone appears at **13:08** in the API log, and
correlating the two by eye makes a delivery that *did* happen look like one that
did not.

```bash
node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"   # machine
grep -E '^TZ=' .env                                                       # the API process
```

## Trap 4 — the tunnel URL dies with the terminal

A `cloudflared` quick tunnel gets a new hostname on every start. When it dies,
Meta keeps the dead callback URL saved and reports no error; deliveries simply
stop. Re-save the callback in Meta after every tunnel restart.

```bash
"/c/Program Files (x86)/cloudflared/cloudflared.exe" tunnel --url http://localhost:3000
```

Order matters: **API on :3000 → tunnel → save the callback in Meta.** Meta fires
the GET the instant you press Save.

This goes away when the API is deployed — the callback becomes
`https://api.neoting.neovogent.com/webhooks/whatsapp`. That host returned 503
until 14 Aug 2026 (CloudFront, WAF and DNS live, both ECS services at
`desired_count = 0`, no image in ECR); issue #25 built the image and the deploy
stage, so the endpoint is stable from the first merge to `main` afterwards.

⚠ A stable callback is **not** a working ingest lane. The deployed task does not
set `INGEST_QUEUE`, so it defaults to `fixture` — a message is signature-checked
and then enqueued in memory, where it is dropped. Verified inbound still means
verified, not stored.

## Prove the chain without waiting on Meta

```bash
# 1 — the app is up
curl -s localhost:3000/healthz

# 2 — the GET handshake, exactly as Meta sends it (expect 200 + the challenge)
T=$(grep -E '^META_VERIFY_TOKEN=' .env | cut -d= -f2)
curl -s "http://localhost:3000/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$T&hub.challenge=NT_TEST"

# 3 — a signed POST (expect 200; corrupt the signature and expect 401)
S=$(grep -E '^META_APP_SECRET=' .env | cut -d= -f2)
SIG=$(openssl dgst -sha256 -hmac "$S" -hex < payload.json | sed -E 's/^.*= ?/sha256=/')
curl -s -X POST http://localhost:3000/webhooks/whatsapp \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: $SIG" \
  --data-binary @payload.json

# 4 — it actually reached the queue
docker exec nt-redis redis-cli --scan --pattern 'bull:ingest:*'
```

Meta sends both `hub.mode` and `hub_mode` spellings on the handshake; the
controller reads the dotted ones.

## Two more things that bite

**A `.env` change needs a real restart.** `tsx watch` watches the module graph,
and `.env` is read by Node before that graph exists — editing a secret and
watching for a reload gets you a process still holding the old value, failing
signature checks that look like a code bug.

**Killing the dev server needs the tree.** Stopping the `pnpm` wrapper leaves the
node grandchild holding `:3000`; the replacement then dies on `EADDRINUSE` and
requests keep hitting the *old* process with the old secrets. On Windows:
`taskkill /PID <pid> /T /F`, and confirm with `netstat -ano | grep :3000`.

## Access tokens

The token in the API Setup panel is a **24-hour** token tied to your login, and
it is only needed for *sending* and for *downloading media* — neither the
handshake nor signature verification touches it. Inbound receipts arrive as media
IDs, so a durable System User token is required before anyone builds media fetch.
Regenerate the temporary one after any session where it has been on screen.

## The +880 number — closed, and it was never open

Recorded here because it was being carried as an open question, and it is not
one. Two locked statements already answer it:

- **D25:** WhatsApp intake runs *"on a **dedicated UK virtual number**"*.
- **Kickoff 4.1:** Twilio — *"**buy one UK virtual number** (for WhatsApp
  registration, 4.2)"*, owner Integrations lead, clock starts night one.

The `Puzzlex` WABA's **+880 1822-706901** is a Bangladeshi number. It cannot be
the client-facing identity of a product whose entire pitch to UK accounting
practices is UK-first — the same instinct that made D30 refuse an EU inference
profile applies to the number a client sees in their phone. Making it the
identity is a **versioned amendment to D25**, not a config choice, and there is
no argument for one: the UK number costs ~£1–5/month.

**So the real action is Kickoff 4.1 — buy the Twilio UK number.** It is a
prerequisite of 4.2 (Meta registration) and it is on the D0 P-list as P4.
Nothing about WhatsApp production moves until it exists.

## Do NOT click Subscribe on the Puzzlex WABA

The `Puzzlex` WABA (`2156858288587947`) has an unclicked **Subscribe webhooks**
button and it should stay unclicked. Clicking it is not a tidying-up step:

1. It begins delivering **real inbound messages from a real number** to
   whatever callback is configured at that moment. During the sprint that has
   usually been a dead `cloudflared` tunnel (trap 4) — and once the API is
   deployed it is the staging endpoint, where `INGEST_QUEUE` defaults to
   `fixture`, so a real client's document would be verified and then dropped in
   memory.
2. G2 is unambiguous: **synthetic data only** until ICO registration and the
   DPIA are done. A real person sending a real receipt to that number is real
   personal data arriving on a system that is not yet allowed to hold it.
3. It attaches a number to the product that D25 says will not be the identity.

Subscribe it when the UK number exists and the ingest lane is real. Until then
the test WABA and its +1 555 number cover every technical question.

## Still open

- **Business Verification** (Kickoff 4.2), needed only for production numbers —
  and blocked behind buying the UK number first.
