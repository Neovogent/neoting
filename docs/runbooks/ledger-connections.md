# Runbook — turning the ledger lane on (D50)

**Written:** 15 September 2026 · **For:** whoever switches `LEDGER_ADAPTER` to
`http` in an environment · **Code:** `apps/api/src/modules/publishing/ledger/`

---

## What is already true

The code shipped on 15 Sep 2026 and is **inert**. `LEDGER_ADAPTER=demo` in every
environment, no vendor application is configured, so `configuredVendors()`
returns an empty list and the client Connections tab offers nothing to connect
to. Every release still takes the export lane, exactly as before.

Nothing below is reversible by a code change alone — turning this on is the act
that lets an approved document reach a real set of books.

---

## ⚠ Read these four before you start

1. **`INTEGRATION_TOKEN_KEY` must be a REAL value before the first connection.**
   It seals every practice's ledger tokens. A placeholder boots perfectly, seals
   everything under a guessable string, and nothing says so. Generate it with
   `openssl rand -hex 32`.
2. **Rotating that key later re-seals nothing.** Every practice would have to
   reconnect every client. Set it once.
3. **Xero has no sandbox.** A developer connects a REAL organisation. The only
   safe target is Xero's own **Demo Company (UK)** — free and resettable. No
   environment variable can make this safe, which is why the Connections screen
   carries the warning instead.
4. **The redirect URI must match byte for byte.** All four applications are
   registered against `https://api.neoting.neovogent.com/v1/integrations/<vendor>/callback`,
   which is the STAGING api host. A local run needs
   `http://localhost:3000/v1/integrations/<vendor>/callback` added at each
   vendor's portal as a SECOND address (FreeAgent's was added 15 Sep 2026).

---

> ✅ **Steps 1 and 2 are DONE as of 15 Sep 2026.** `secrets.tf` carries the
> `ledger` group and `services.tf` carries the settings and the injection, with
> `LEDGER_ADAPTER` still `demo`. What is left is Step 3 (the real values), the
> apply, and Step 4 (the flip). The Terraform below is kept as the record of
> what was added and why.

## Step 1 — the secret group (Terraform)

`infra/envs/staging/secrets.tf` holds one secret per VENDOR, each a JSON
object. Add a tenth group beside the nine that are there:

```hcl
    # XERO_CLIENT_ID/SECRET, QBO_*, SAGE_*, FREEAGENT_* — our four APPLICATION
    # registrations, never any client's connection. Values are in
    # `.env.integrations` (gitignored) and are set OUT OF BAND, per the
    # placeholder discipline at the top of this file.
    #
    # ⚠ `integration_token_key` is NOT a vendor credential and is the one value
    # here that must never be a placeholder — it seals every practice's ledger
    # tokens. `openssl rand -hex 32`.
    ledger = {
      description = "Ledger application credentials (D50) - Xero, QuickBooks, Sage, FreeAgent - plus the key that seals per-connection tokens"
      values = {
        integration_token_key   = "PLACEHOLDER_INTEGRATION_TOKEN_KEY"
        xero_client_id          = "PLACEHOLDER_XERO_CLIENT_ID"
        xero_client_secret      = "PLACEHOLDER_XERO_CLIENT_SECRET"
        qbo_client_id           = "PLACEHOLDER_QBO_CLIENT_ID"
        qbo_client_secret       = "PLACEHOLDER_QBO_CLIENT_SECRET"
        sage_client_id          = "PLACEHOLDER_SAGE_CLIENT_ID"
        sage_client_secret      = "PLACEHOLDER_SAGE_CLIENT_SECRET"
        freeagent_client_id     = "PLACEHOLDER_FREEAGENT_CLIENT_ID"
        freeagent_client_secret = "PLACEHOLDER_FREEAGENT_CLIENT_SECRET"
      }
    }
```

⚠ **A new GROUP, not new keys in the `auth` group.** `ignore_changes =
[secret_string]` covers the whole attribute, so a key added to an existing group
never reaches AWS — that file says so at length. A new group is written once, at
creation, which is exactly what is needed here.

## Step 2 — the task definition (Terraform)

In `infra/envs/staging/services.tf`, alongside the other plaintext values:

```hcl
    # D50. `demo` keeps the lane inert; `http` means an approved document
    # reaches a real set of books.
    { name = "LEDGER_ADAPTER", value = "demo" },
    { name = "LEDGER_SANDBOX", value = "true" },
    { name = "XERO_REDIRECT_URI", value = "https://api.neoting.neovogent.com/v1/integrations/xero/callback" },
    { name = "QBO_REDIRECT_URI", value = "https://api.neoting.neovogent.com/v1/integrations/quickbooks/callback" },
    { name = "SAGE_REDIRECT_URI", value = "https://api.neoting.neovogent.com/v1/integrations/sage/callback" },
    { name = "FREEAGENT_REDIRECT_URI", value = "https://api.neoting.neovogent.com/v1/integrations/freeagent/callback" },
```

and in the `secrets` block:

```hcl
    { name = "INTEGRATION_TOKEN_KEY", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:integration_token_key::" },
    { name = "XERO_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:xero_client_id::" },
    { name = "XERO_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:xero_client_secret::" },
    { name = "QBO_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:qbo_client_id::" },
    { name = "QBO_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:qbo_client_secret::" },
    { name = "SAGE_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:sage_client_id::" },
    { name = "SAGE_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:sage_client_secret::" },
    { name = "FREEAGENT_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:freeagent_client_id::" },
    { name = "FREEAGENT_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.app["ledger"].arn}:freeagent_client_secret::" },
```

⚠ **The api service AND the workers service both need them.** The refresh sweep
runs on workers, and a worker that cannot open the vault cannot renew a
connection — which fails silently, weeks later, as an expired refresh token.

⚠ **`LEDGER_ADAPTER` stays `demo` in this step.** Land the plumbing first and
prove the task still boots; flipping it is Step 4 and is its own decision.

## Step 3 — the real values, out of band

Terraform writes placeholders once and never looks again
(`ignore_changes = [secret_string]`). Set the real values with a FILE, never an
inline `--secret-string` — an inline one lands in shell history and in the
CloudTrail request record:

```bash
# Compose the JSON from .env.integrations. Both files are gitignored.
cat > /tmp/ledger.json <<'JSON'
{
  "integration_token_key": "<openssl rand -hex 32>",
  "xero_client_id": "...", "xero_client_secret": "...",
  "qbo_client_id": "...", "qbo_client_secret": "...",
  "sage_client_id": "...", "sage_client_secret": "...",
  "freeagent_client_id": "...", "freeagent_client_secret": "..."
}
JSON

aws secretsmanager put-secret-value \
  --secret-id /neoting/staging/ledger \
  --secret-string file:///tmp/ledger.json

rm /tmp/ledger.json          # ⚠ do not skip
```

⚠ **A partial write DELETES the omitted keys**, and a task definition naming a
key the secret does not hold fails at task start with
`ResourceInitializationError`. Always write the whole object.

Restart the services so the agent re-reads them — new env only reaches a task at
start:

```bash
aws ecs update-service --cluster nt-staging --service nt-staging-api     --force-new-deployment
aws ecs update-service --cluster nt-staging --service nt-staging-workers --force-new-deployment
```

## Step 4 — flip it on

`LEDGER_ADAPTER=http` in `services.tf`, apply, and restart. The boot gates in
`config/env.ts` refuse to start if the sealing key is missing or malformed, or
if no vendor application is configured — so a task that comes up healthy is a
task that can actually connect.

Then drop the twelve entries from `LOCAL_ONLY` in
`scripts/check-env-parity.mjs`; its own hygiene check will fail until they go.

## Step 5 — prove it, per vendor

For each of Xero, QuickBooks, Sage and FreeAgent:

1. Open a client, **Connections**, press **Connect**.
2. Complete the vendor's consent screen. ⚠ For Xero, pick **Demo Company (UK)**.
3. Land back on the Connections tab. The card should read **Connected**, name
   the organisation, and show a non-zero account count.
4. Take a seeded document through read → code → **Read review opened** →
   **Approve**.
5. **Open the vendor's own UI** and confirm the transaction is there: right
   supplier, right total to the penny, right VAT, and **the receipt visibly
   attached**. A screenshot of that screen is the acceptance evidence.
6. `GET /v1/publishes` shows `SUCCEEDED` with the vendor's reference in
   `externalRef`.

Then break it on purpose: revoke at the vendor and confirm the screen says
reconnect; force a refresh and reconnect to prove the rotated token persisted;
publish a batch with one rejected item; send an oversized attachment to
FreeAgent and confirm `attachmentSent` is false.

⚠ **Never create test data in a real client's books.**

## Rolling back

`LEDGER_ADAPTER=demo` and restart. Existing connections stay in the database and
stop being used; every release goes back to the export lane.

⚠ **That sentence was not true when this runbook was first written, and the fix
is worth knowing about.** `DemoXeroAdapter` answers every publish with `ok` and
a deterministic `XERO-INV-####`, so a client with a live connection on a
`demo` deployment would have taken the LEDGER arm and been marked PUBLISHED
against a reference that exists nowhere. `PublishGateway.ledgerLaneEnabled` is
what now sends those releases down the export lane instead, and
`publish-batch.test.ts` pins it. The connection screen also stops offering
Connect while the lane is off, so no new connection can be made into that gap. Nothing already
posted to a client's books is touched, and nothing should be — a transaction in
their ledger belongs to them.

To remove a connection properly, use **Disconnect** on the Connections tab: it
destroys the stored credentials and the synced lists rather than merely
switching the row off.
