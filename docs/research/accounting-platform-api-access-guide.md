# Accounting Platform API Access — A Practical Guide for Neoting ("Neo Accounting")

**Prepared:** 3 September 2026
**For:** the owner of Neoting / Neo Accounting (Exam Binary Ltd, company number 16261850 — to be confirmed)
**Subject:** exactly how to obtain production API access from every major accounting platform, in the UK first and Australia second, so that this product can one day write bookkeeping entries into a client's ledger.

---

## 0. Read this first — what this document is, and what it is not

> **⚠ This is preparation for future work. Nothing here is being switched on now.**
>
> Neoting today **deliberately has no ledger API**. Decision **D42** in `docs/Source_Of_Truth.md` supersedes D6 for the current release (Initial Delivery, "ID"): **export to a VT Transaction+ import file is the sole egress**, and the internal state *Published* means **"approved and released for export"** — it asserts nothing whatsoever about a ledger, and no surface in the product may imply otherwise. The v1 plan does name **Xero and QuickBooks adapters**, and this guide is the map for getting from here to there.
>
> Read this as a procurement and paperwork plan with a 3-to-12-month lead time, not as an engineering task list. Several of these programmes take longer to get *through* than the adapter takes to *build*, which is the whole reason for writing it down early.

### What the product is, in one paragraph

Neoting is a **chat-first document-to-bookkeeping platform for UK accounting practices**. Receipts and invoices arrive by photo, email, WhatsApp or upload; the pipeline reads them, codes them, dedupes them and matches them to the bank statement; a human presses **Approve**; the result is released. Markets are **UK first, Australia second**. Money is **integer pence** throughout — there is no float anywhere in the codebase, and that is lint-enforced.

### The three product facts that change which programme you apply to

| # | Fact | Why it changes the answer |
|---|---|---|
| **1** | **The users are PRACTICES acting for many client businesses** — not one company connecting its own accounting software. | This is the single most important line in this document. It makes Neoting a **multi-tenant app connecting to hundreds or thousands of separate accounting organisations**. On several platforms that is a different developer programme, a different partner tier, a different review, and a different set of connection limits from a single-company app. Where a vendor's documentation says "connect your organisation", assume it was not written for you and read the partner-programme page instead. |
| **2** | **Nothing changes state without a human approving it.** No side-effect path exists outside the ActionProposal / Review → Approve gate, enforced server-side. | This is a *help* in every app review — reviewers actively look for apps that write without user intent. It is a *constraint* on rate-limit design: writes arrive in human-paced approval bursts, not smooth background sync. And it makes several platforms' "auto-post" certification criteria irrelevant. |
| **3** | **D43 — every exported line must resolve back to its source document.** | Through a file, this is a typable capability URL in a text field. Through an API it should be a **real file attachment on the transaction**. This guide therefore states, per platform, **whether the API can attach the source file to the transaction** — because that is how D43 would be honoured through an API rather than through a file. |

### Jargon, defined once

| Term | Meaning here |
|---|---|
| **OAuth 2.0 authorization code grant** | The standard "click to connect" flow: the practice user is redirected to the platform, logs in, chooses an organisation, and consents; the platform hands your server a short-lived code which you exchange for tokens. Every platform in this document uses it. |
| **Access token / refresh token** | The access token authorises API calls and expires in minutes to hours. The refresh token buys a new access token and typically lasts much longer. **Refresh-token rotation** means the old refresh token dies the moment you use it — you must persist the new one atomically or you lose the connection. |
| **Scope** | A named permission requested at connect time, e.g. `accounting.transactions`. You cannot widen scopes later without re-consent. |
| **Tenant / realm / company file / organisation** | The platform's word for one client business's books. A practice serving 200 clients means up to 200 of these, each with its own token pair. |
| **Certification / app review** | A vendor's inspection of a live app before it is allowed either into production at scale or onto a public marketplace. Distinguish the two — they are not always the same gate. |
| **Uncertified connection limit** | A cap on how many separate organisations an unreviewed app may connect to. **This number decides whether a pilot can even run**, and it is the most commonly misunderstood figure in the whole space. |
| **Minor units vs decimals** | Neoting stores **integer pence**. Most accounting APIs express money as a **JSON decimal number**. Every such boundary is a conversion risk and is flagged per platform below. |

---

*(Sections below are appended as research completes. Any claim not verified against official vendor documentation is marked **"not verified"** rather than guessed.)*

---

## 1. Platform-by-platform

### 1.0 The whole picture in two tables

**Table A — access, gates and cost.** *(⚠ Every figure verified 3 September 2026. Several changed materially in 2025–26; check dates before relying on any of them.)*

| Platform | Programme fee | ⚠ **Uncertified connection cap** | Review required for **production**? | Review required for **listing**? | Time to first real client ledger |
|---|---|---|---|---|---|
| **Xero** | Free → A$35 → **A$245** → A$1,445/mo | ⚠ **5** (Starter). **50** with a card on file (Core). 1,000 needs certification | **No, up to 50 orgs** | Yes (Plus tier+) | **2–4 weeks** eng; **3–6 months** to certified scale |
| **QuickBooks Online** | Free (Builder) → **£225/mo** (Silver) | ✅ **None documented** once the questionnaire is approved | ⚠ **Yes — the App Assessment Questionnaire** | Yes (3-part review) | **2–6 weeks** |
| **Sage Business Cloud Accounting** | **Free** | ✅ **None documented** | **No** | Yes (informal Teams demo) | **6–8 weeks** |
| **Sage 50 (UK)** | ⚠ **~£2,500 + VAT/yr** (2026 figure redacted) | N/A — structurally unenforceable | No (no server exists) | Yes + paid integration test | ⚠ **5–9 months** |
| **FreeAgent** | **Free** | ✅ **None documented** *(historical restriction unverified — confirm)* | **No** — a hostname swap | Marketing-led only | ✅ **4–7 weeks** |
| **MYOB (Business + AccountRight)** | ⚠ **A$110 / A$220 / A$630 per month** | ✅ **None found** — but **≥5 live users required before listing** | **No** | Yes (Developer Partner tier+) | **8–14 weeks** |
| **Reckon One** | **Free** | **None documented** | **No** | Support ticket | **5–9 weeks** |
| **Zoho Books** | Free | Not documented; ⚠ **20 refresh tokens per user** | No | Yes (2–3 weeks) | Not estimated |
| **Odoo** | Free | ⚠ **External API only on the Custom plan** | No | 30% App Store commission | Not estimated |
| **VT Transaction+** | n/a | n/a | n/a | n/a | ❌ **No API exists at all** |

**Table B — the mechanics that decide whether the integration is any good.**

| Platform | **✅ D43: attach source file?** | Attachment limit | Money on the wire | Idempotency | **Practice multi-tenancy** | Refresh token life |
|---|---|---|---|---|---|---|
| **Xero** | ✅ **Yes** — *plus* a clickable `Url` deep link | **10 files × 10 MB** | ⚠ `format: double` on 98 fields | ⚠ 6-minute window | ⚠ **One consent per org.** Bulk Connections gated at **A$1,445/mo** | **60 days**, rotating |
| **QuickBooks Online** | ✅ **Yes** — bytes only, ⚠ **no URL field** | **100 MB/request**; 17-type allowlist | ⚠ JSON decimal; `UnitPrice` overrides `Amount` | ❌ **None** — `DocNumber` only | One consent per realm | **100 days**, rotates every 24h |
| **Sage Accounting** | ✅ **Yes** — and ✅ **accepts TIFF** | ⚠ **not verified** | ⚠ `double`; sometimes a string on read | ✅ **Yes — 7-day window** | ✅ **Partner Edition: one grant → all clients** | 31 days, rotating |
| **Sage 50 (UK)** | ❌ **No** — link + reference field only | 5 MB, **GUI only** | ⚠ `Double`; **VAT silently recalculated** | ❌ None | ⚠ **One Windows agent per data location** | n/a — a stored password |
| **FreeAgent** | ✅ **Yes** — sub-object, **one call** | ⚠ **5 MB**; ⚠ `application/x-pdf` | ✅ **Decimal *strings*** — the only one | ❌ None | ✅ **Practice API: one grant → all clients** | ✅ **≈20 years** |
| **MYOB** | ✅ **Yes** — Bills *and* Spend Money | ⚠ **<3 MB base64** (≈2.2 MB raw) | `Decimal 13.2`; known 1c defect | ❌ None; ⚠ 29s timeout ambiguity | One invite per company file | ⚠ **1 week** |
| **Reckon One** | ✅ **Yes** — raw binary | **10 MB × 3** | ⚠ JSON `number`, **no declared scale** | ❌ None | `GET /books` | Not verified |
| **Zoho Books** | ✅ **Yes** — with a **reverse link** | Not verified | ⚠ `double` | ❌ None | `organization_id` param | ✅ Never expires |
| **VT Transaction+** | ❌ **No — VT cannot attach files at all** | n/a | Decimal text | n/a | n/a | n/a |

> **Three patterns worth naming before the detail.**
>
> **1. The cheap SKU is where the API gets thin — on every platform.** Xero excludes ledger/cashbook client organisations from practical bill posting; MYOB's Connected Ledger has **no Bills API at all**; Sage Accounting **Start** cannot take purchase invoices. **These are exactly the plans practices put their smallest clients on.** Build the posting engine with a capability probe and a documented fallback (`other_payments`, `SpendMoneyTxn`) from day one, and **size that share of each practice's book before pricing.**
>
> **2. Certification is a distribution gate, not a technical one.** On Xero, QBO, Sage Accounting, FreeAgent, MYOB and Reckon, **the attachments API needed for D43 is available before any commercial relationship exists.** You can prove D43 end-to-end on a sandbox in week one.
>
> **3. Money crosses as a float almost everywhere.** Eight of the nine live platforms express money as a JSON number or a `Double`. **FreeAgent's decimal strings are the sole exception.** For a codebase whose central invariant is integer pence, **every adapter needs its own conversion boundary with the same care as `exports-public-api/canonical/money.ts`** — and a read-back reconciliation before release, because several platforms recompute tax server-side.


### 1.1 Xero

> **⚠ Read this first.** The widely-quoted **"25 connections for uncertified apps"** figure is **obsolete**. Xero replaced it on **2 March 2026** with a five-tier commercial model in which a **new, uncertified app is capped at 5 connections**, and the revenue-share model was retired entirely. Three Xero doc pages still say "25" and are stale — listed in §1.1.4. Every figure below was verified against live Xero pages on **3 September 2026**.

#### 1.1.1 Which programme — three different things with confusingly similar names

| | **Xero Developer account** | **Xero App Partner / Developer Platform** | **Xero Partner Programme (Advisor)** |
|---|---|---|---|
| What it is | Free Xero login + developer portal; register an OAuth 2.0 app | The commercial tiering + certification programme for apps integrating with Xero | The accounting-practice loyalty programme (Bronze→Platinum) |
| Portal | [xero.com/signup/developers](https://www.xero.com/signup/developers/) → [developer.xero.com/app/manage](https://developer.xero.com/app/manage) | [developer.xero.com/pricing](https://developer.xero.com/pricing); upgrade via **My Apps → Manage Plan** | [xero.com/uk/partner-programme](https://www.xero.com/uk/partner-programme/) |
| Cost | Free | Starter free; Core A$35/mo; Plus A$245/mo; Advanced A$1,445/mo | Free |
| **Neoting needs it?** | **Yes — day 1** | **Yes — this is the path** | **No.** This is what Neoting's *customers* are, not Neoting. |

**Do not confuse these.** Neoting is a software vendor, so it takes the **App Partner / Developer Platform** route. Its *users* (UK practices) will separately be Xero Advisor Partners — commercially relevant to them, but conferring Neoting nothing.

**Order of operations** ([Getting started](https://developer.xero.com/documentation/getting-started-guide), [Building and growing your app](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/building-and-growing-your-app)):

1. **Sign up for a free Xero account** → [xero.com/signup/developers](https://www.xero.com/signup/developers/).
2. **Enable the Demo Company** from [my.xero.com](https://my.xero.com/) (§1.1.8).
3. **Register the OAuth 2.0 app.** Grant type **"Auth Code"** (server app that can hold a secret), not PKCE. App name **must not contain the word "Xero"** and must be the go-to-market name. Redirect URI **must be https**; `http://localhost/` is allowed for testing but **`http://127.0.0.1` is explicitly not accepted** ([auth-flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/)).
4. **Build against the Demo Company.** App defaults to **Starter: 5 connections**.
5. **Add a credit card** → **Core: 50 connections**. This is the "6th connection" trigger ([Pricing FAQs](https://developer.xero.com/faq/pricing-and-policy-updates)).
6. **Onboard ~10 beta practices.** Certification checks you have built Sign Up with Xero and hold **ten active customer connections**.
7. **Apply for certification as part of the Core→Plus upgrade**, via **Manage Plan** in the Developer Centre.
8. **Plus = 1,000 connections.** App Store listing optional here.
9. **Security self-assessment** before 1,000 connections (Xero sends it at 800) — required to pass 999 and to reach **Advanced: 10,000**.

> ⚠ **The step that matters most for a practice product.** **Bulk Connections** — one OAuth flow connecting many client organisations at once, described by Xero as "especially valuable for accountants and bookkeepers" — is an **Advanced-tier-only premium feature requiring certification + security assessment + use-case approval** ([App partner features](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/app-partner-features)). Without it, a practice must complete **one OAuth round-trip per client organisation**. For a practice with 200 clients that is 200 separate consent journeys. **This is the single biggest architectural and UX fact on this page.** The same tier gate applies to the Journals endpoint and the XPM (Practice Manager) API.

#### 1.1.2 What Xero demands of the applicant company

The published bar is a **self-assessment**, not an audit. The standard is [Security standard for Xero API consumers](https://developer.xero.com/partner/security-standard-for-xero-api-consumers/), based on the DSPANZ Security Standard for Add-on Marketplaces:

| # | Domain | Concrete requirement |
|---|---|---|
| 1 | Encryption key management | OAuth 2.0 mandatory. Refresh token encrypted at rest with 3DES or AES (**AES-128 or greater preferred**); key in a separate config file. Tokens never exposed in-app or shared. |
| 2 | Encryption in transit | **TLS 1.2 with AES-256 or higher and SHA-256 is mandatory.** Endpoints receiving tokens in URL params must **302 redirect**, not return an HTML body (Referer-leak prevention). |
| 3 | Authentication | **Minimum two-step authentication or SSO.** "Use of Sign in with Xero is strongly recommended." |
| 4 | Indirect access to data | Third-party access must be **stated in your policies and/or T&Cs** with a justifiable business need. |
| 5 | Server configuration | Industry hardening (NIST *Guide to General Server Security*). |
| 6 | Vulnerability management | **OWASP Top 10**; CSRF, XSS, SQLi, XML injection, session management, validated redirects; session cookies `Secure` and `HTTPOnly`. |
| 7 | Encryption at rest | **NIST cryptographic mechanisms mandatory** for repositories holding sensitive commercial or personal information. |
| 8 | Audit logging | Date/time, user or process, description, success/failure, source, equipment ID. **Minimum one year retention. Logs must be immutable and secure.** |
| 9 | Data hosting | "Ensure client data is not hosted in high risk areas" — country, legal, contractual, access, **sovereignty** and counter-party risk. |
| 10 | Security monitoring & breach reporting | Demonstrable scanning at network, app and data layer; **anomalies must be reported to Xero**. |

**On the specific things that usually delay applicants:**

| Requirement | Xero's position |
|---|---|
| **Penetration test evidence** | **Not required** by the published standard. Whether Xero requests one informally during review is **not verified**. |
| **SOC 2** | **Not required.** Not mentioned in the standard, the terms, or the certification checkpoints. |
| **Insurance** | **Not required.** No insurance clause in the [Commercial Terms](https://developer.xero.com/xero-developer-platform-commercial-terms) or [Platform Terms](https://developer.xero.com/xero-developer-platform-terms-conditions). |
| **Named security contact** | **Not verified** as an explicit field, but domain 10 obliges you to report anomalies to Xero, which implies one. |
| **Data residency** | A risk-based **"consideration", not a hard commitment**. No UK/EU-only rule. UK/EU hosting is the safe answer for a UK practice product but Xero does not mandate it. |
| **VAT / company details** | **Required for billing.** Commercial Terms §2.4(a): you must supply "legal entity name(s), country of residence and establishment, GST/VAT/Sales Tax registration status, and registration number(s)", and you indemnify Xero if you don't. Fees are tax-exclusive. **→ This is blocker B1 in §3.1.** |
| **Public website / support** | **Required at listing stage**, not at registration: Website URL, Support email, Support URL are mandatory listing fields, plus publicly accessible support documentation. |
| **Privacy law** | An explicit contractual term. Commercial Terms §4.2(c) names the **UK Data Protection Act 2018, UK GDPR, and PECR 2003**. |
| **Payment method** | **Credit card only.** "Not at this time. The only approved billing method is by credit card." |

Contracting entity is **Xero (NZ) Limited** (NZ company no. 4123758).

**Security assessment timing** ([Ecosystem Security Requirements Update](https://developer.xero.com/faq/xero-ecosystem-security-requirements-update)): "Typically the assessment takes around **5 working days to complete**, followed by **5–10 working days for us to assess your answers**." Failure → remediation report → **30 days to provide a plan, then 60 days to implement**. **Annual** thereafter, and certification carries its own annual recertification (Commercial Terms §2.1). Triggered by >1,000 connections, or **any** use of Practice Manager / Xero HQ / Xero Tax APIs, or Xero's discretion.

> ⚠ **AI/ML prohibition — read this carefully, it is existential for a document-AI product.** Effective for new developers from **4 December 2025**: "**data obtained from Xero's APIs may not be used to train AI/ML models**" ([Pricing page](https://developer.xero.com/pricing)). Neoting may *call* models on Xero data; it **may not train or fine-tune on it**. Given that Neoting's pipeline is model-driven, confirm the architecture is inference-only on Xero-sourced data and that no Xero-derived data reaches a training or fine-tuning set — including via evaluation corpora that later become training data. Also prohibited: "apps must not use bots or browser extensions to undermine our security controls or simulate user actions."

#### 1.1.3 Certification, app review and marketplace listing

**Is review required for production? No — up to 50 connections.** You can write to real client ledgers on Starter (5) and Core (50) with **no review at all**. Certification becomes mandatory only to reach **Plus (1,000)**. An App Store listing is a **separate, optional** thing at Plus and Advanced, and required only at Enterprise.

| Tier | Certification required? | Security assessment? | App Store listing |
|---|---|---|---|
| Starter | No | No | Not available |
| Core | No | No | Not available |
| **Plus** | **Yes** | No | Optional |
| **Advanced** | **Yes** | **Yes (initial + annual)** | Optional |
| **Enterprise** | **Yes** | **Yes (initial + annual)** | **Required** |

Source: [developer.xero.com/pricing](https://developer.xero.com/pricing).

**What gets reviewed** — the nine [Certification checkpoints](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/certification-checkpoints):

1. **Sign Up with Xero** — mandatory for listing; if implemented you must also implement **Sign In with Xero**.
2. **Tier** — Plus or higher.
3. **Connection management UI** — must show connected tenant name and status, a Connect button when disconnected, a **Disconnect button that actually calls the API**, and must handle a user disconnecting from Xero's side. **Explicitly forbidden:** asking for Xero credentials in-app; pop-ups or new tabs for the auth flow; exposing access token, client id or client secret client-side.
4. **Branding and naming** — no "Xero" in the app name; use Xero's supplied connect/disconnect buttons.
5. **Scopes** — minimum necessary. "Unexplained or ambiguous use of scopes will not be allowed." **`offline_access` is itself a certification requirement.**
6. **Error handling** — surface Xero's error messages to the user.
7. **Data integrity** — ACTIVE account codes; avoid system accounts (800, 610) except overpayments; non-ARCHIVED contacts; **multicurrency handling is mandatory even if you think you don't need it**.
8. **Account and payment mapping** — mandatory if you create data.
9. **Taxes** — must use Xero's tax rates; allow mapping.

The [certification matrix](https://developer.xero.com/documentation/best-practices/overview/cert-matrix) additionally marks as **Required**: App Store Subscriptions (effort: High), App Store Listing, Branding, Chart of Accounts Mapping, Connections, Multicurrency (High), Error Handling, Payments mapping, **Rounding**, Scopes, **Taxes**, Sign Up with Xero, and **Webhooks**.

**What commonly fails** — Xero names these directly:

- **Hard-coding account codes.** *"A common error we see is apps assuming the sales account will always be 200, this isn't always the case."*
- **Free-text account code entry** instead of filtered dropdowns — explicitly required for certification.
- **Auto-creating accounts** without user choice — explicitly required for certification.
- **Rounding drift.** Xero calculates tax **per line, rounded to 2dp, then sums**. Systems that total then tax diverge by pennies. *"If you do not meet the requirements above you will be required to make changes before proceeding with certification."*
- **Posting explicit tax amounts.** *"We request that you avoid posting the specific tax amounts unless you've discussed it with your Developer Evangelist first."*
- No multicurrency plan; not disconnecting churned tenants.

**Listing mechanics:** self-service form → **Submit listing** → you cannot edit while under review → a **Developer Evangelist** confirms go-live. Post-live, most edits go live in ~30 minutes, but purchase/sign-up URL, industries, functions and available regions are review-gated. Assets: SVG logo, ≤6 screenshots (JPG/PNG, ≤5 MB, 1280×800), short description ≤300 chars, About / Integration details / Getting started ≤3,000 chars each.

> **Revenue share — RETIRED, and this is good news.** The old model took **15% of your ARPU per successful App Store referral**. It has been replaced: *"we are retiring our current revenue share model (comprising Xero App Store Subscriptions and Commercial Billing)"*. Xero App Store Subscriptions (XASS) is being wound down — all XASS customers had to be migrated off by **1 July 2026**. **Net effect: you bill your practices directly and Xero takes 0% of your revenue**, charging a flat platform fee instead (§1.1.9). The [App partner FAQs](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/faqs) still describe the old 15% model and are stale.

#### 1.1.4 ⚠ Connection limits before certification — the number, verified

**A new uncertified app is limited to 5 connections (Starter). Adding a payment method moves you to Core = 50. Certification is what unlocks 1,000.**

| Tier | Max connections | Gate |
|---|---|---|
| **Starter** (default for all new apps) | **5** | none |
| **Core** | **50** | payment method on file |
| **Plus** | **1,000** | **App Certification** |
| **Advanced** | **10,000** | Certification + Security Assessment (initial & annual) |
| **Enterprise** | **No limit** | Certification + Security Assessment + App Store listing |

Sources, all current: [developer.xero.com/pricing](https://developer.xero.com/pricing) (tier table, page updated 2026-01-09); [OAuth 2.0 API limits](https://developer.xero.com/documentation/guides/oauth2/limits/) — *"New apps default to the starter tier with 5 connections. Moving up to Core will give you up to 50 connections."*; [Tenants](https://developer.xero.com/documentation/guides/oauth2/tenants); [Pricing FAQs](https://developer.xero.com/faq/pricing-and-policy-updates) — *"The Starter tier has unlimited data access to enable early innovation but is capped at 5 connections. In order to add a 6th connection, you will need to first add your payment details."*

**⚠ Xero's own documentation contradicts itself. Three pages are stale and still say 25:**

| Page | Says | Status |
|---|---|---|
| [auth-flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/) | "Uncertified apps can only connect to 25 tenants." | **STALE** |
| [getting-started-guide](https://developer.xero.com/documentation/getting-started-guide) | "With OAuth 2.0 you get a connection limit of 25 Xero customers" | **STALE** (the next bullet on the same page points at the new tier model) |
| [Managing connections](https://developer.xero.com/documentation/best-practices/managing-connections/connections) | "Uncertified apps are limited to 25 tenant connections" | **STALE** |

**Treat 5 as the operating number.** If Xero support quotes 25, the tier table and pricing FAQ are the authoritative dated sources.

**Three further limits that bite a practice product specifically:**

1. ⚠ **"Each organisation or practice is limited to connecting a maximum of two uncertified apps. There is no limit on connecting certified apps."** ([Limits](https://developer.xero.com/documentation/guides/oauth2/limits/)). **Your pilot practices' client organisations may already have two uncertified apps attached — in which case Neoting cannot connect at all until certified.** This is a real and common blocker, and it is invisible until you hit it. Ask pilot practices to check.
2. **How connections are counted.** *"Multiple users can connect your app to the same tenant, but only one of those connections will count towards your connection limit."* The unit is **the client organisation**, not the practice staff member. A practice with 200 clients = 200 connections. **Ten mid-size UK practices will blow past Plus's 1,000.**
3. **Connections never expire on their own.** *"Connections will continue to exist and stay active indefinitely even if no API calls are being made or if the access token expires."* You pay for zombies, and Commercial Terms §2.2(d) makes cleanup **your** contractual responsibility. Build the disconnect job on day one — Xero publishes a page on it ([Identifying inactive connections](https://developer.xero.com/documentation/best-practices/managing-connections/identifying-inactive-connections)).

#### 1.1.5 Auth model — the crux for a multi-tenant practice product

**Flavour:** OAuth 2.0 **Authorization Code with a client secret**. PKCE exists but is *"required for applications like desktop and mobile apps that can't securely store a client secret"* — not Neoting's case. A **Client Credentials** grant also exists, non-tenanted, used only for connection management and App Store APIs.

| Endpoint | URL |
|---|---|
| Authorize | `https://login.xero.com/identity/connect/authorize` |
| Token | `https://identity.xero.com/connect/token` |
| Revocation | `https://identity.xero.com/connect/revocation` |
| Connections | `https://api.xero.com/connections` |

**Token lifetimes** ([Token types](https://developer.xero.com/documentation/guides/oauth2/token-types)):

| Token | Lifetime | Rotates? |
|---|---|---|
| authorization `code` | **5 minutes**, single use | n/a |
| `id_token` | **5 minutes** | n/a |
| `access_token` | **30 minutes** | new one on each refresh |
| `refresh_token` | **60 days** | **YES — rotates on every use** |

**Refresh tokens rotate**, and there is a **30-minute grace window**: *"If your app doesn't receive the response, or fails to save the new token, you can retry using your existing refresh token for a grace period of 30 minutes."* Build the token store so a crashed write is recoverable inside 30 minutes.

**The "60-day rule", precisely stated:** it is not an inactivity rule on the *connection*; it is an expiry on the *refresh token*, with **rolling 60-day validity refreshed on use**. **You must exercise every tenant's refresh token at least once every 60 days or that client organisation drops out and the practice must re-authorise.** Xero adds: *"Xero does not provide an expiry date for the refresh token, so you will need to compute this and store it in your database."* Expiry surfaces as **HTTP 400 + `invalid_grant`**. Token expiry does **not** delete the connection — you still pay for it and it still shows as connected until you DELETE it.

> ⚠ For Neoting this means a **mandatory scheduled refresh job across every tenant, decoupled from user activity**. It is first-class infrastructure, not a detail — and it does not exist today (§4.2).

**Scopes — and a major 2026 change.** Xero introduced **granular scopes on 2 March 2026**. Broad scopes are deprecated and die in **September 2027** ([Scopes](https://developer.xero.com/documentation/guides/oauth2/scopes), [Granular scopes FAQ](https://developer.xero.com/faq/granular-scopes)).

> **Apps created on or after 2 March 2026 use the new granular scopes.** Neoting will be a new app → **`accounting.transactions` is not what you should ask for.**

| Purpose | **Scope to request (granular)** | Deprecated equivalent |
|---|---|---|
| Create/update ACCPAY bills | **`accounting.invoices`** | `accounting.transactions` |
| Attach the source document | **`accounting.attachments`** | (unchanged) |
| Chart of accounts, tax rates, tracking, org | **`accounting.settings.read`** | (unchanged) |
| Suppliers | **`accounting.contacts`** | (unchanged) |
| Bank matching (read statement lines) | **`accounting.banktransactions.read`** | `accounting.transactions.read` |
| Refresh tokens | **`offline_access`** — *required for certification* | |
| SSO / Sign Up with Xero | `openid profile email` | |
| Connection cleanup via client credentials | `app.connections` | |

Scopes are **additive** and cannot be removed from an existing token — reducing them means revoke and start over. Calling an endpoint without the granular scope returns **401 with `WWW-Authenticate: insufficient_scope`**; catch it and prompt "Update Permissions". **You cannot mix tenant types in one authorisation** — *"you cannot request an accounting scope alongside a practice manager scope"*.

**Managing many client organisations — the mechanics:**

1. A practice user completes one OAuth flow. **A single access token covers every tenant that user has connected.**
2. `GET https://api.xero.com/connections` returns `{id, authEventId, tenantId, tenantType, tenantName, …}`. `tenantType` is `ORGANISATION`, `PRACTICEMANAGER` or `PRACTICE`.
3. Filter to just-authorised orgs with `?authEventId=<from the decoded access token>`.
4. Every API call carries **two** headers: `Authorization: Bearer …` **and `xero-tenant-id: <tenantId>`**.
5. ⚠ **Store tokens keyed on `xero_userid`, not per tenant.** Xero: *"It's highly recommended you save the tokens to a global Xero tokens table, and use the xero-user-id as the primary key, to avoid invalidating a token unintentionally."* **Storing one row per tenant will cause rotation races that silently kill connections.** Note this cuts directly against Neoting's current schema, where `Integration` is keyed `@@unique([businessId, kind])` — i.e. one row per client business. The token itself must live in a user-keyed vault with the `Integration` row holding only a `tokenRef` pointer and the `orgRef` tenant id. **The existing schema's `tokenRef` indirection accommodates this — but only if the vault is keyed correctly.**
6. Disconnect: `DELETE https://api.xero.com/connections/{connectionId}` → 204. **`connectionId` ≠ `tenantId`.**

> ⚠ **Thread safety — Xero puts this on you explicitly.** *"You must be careful when handling tenantIDs and tokens as there is a risk of data leakage across tenants if there is a misuse of shared resources e.g. static variables, caches, or connection pools… Thread safety in these cases is your responsibility and must be adhered to."* For a product posting to hundreds of client ledgers, a tenant-ID mix-up is a catastrophic, unrecoverable event — you would have posted one client's purchases into another client's books. Treat `xero-tenant-id` as a required, validated argument on every call path, with a pre-request assertion that the mapped organisation matches the `businessId` in scope. This is the API-side analogue of Neoting's existing `scopedDb(ctx)` rule and deserves the same lint-level seriousness.

**Practice-edition gotcha, and it is a commercial one:** *"Authorisation of connections to cashbook or ledger organisations must be done by a member of the practice staff — managed client or cashbook client roles cannot authorize an API connection."* And: *"as these plans do not include invoicing functionality, any invoices created via the API could not be edited or modified, so this function is recommended to be avoided."* **Ledger and cashbook client organisations are effectively out of scope for a bill-posting product.** Many UK practices run a large share of their smallest clients on exactly these plans. **Size that share before pricing** — it may be a material fraction of the addressable book.

#### 1.1.6 The API surface

**Creating a purchase bill (ACCPAY)** — `POST https://api.xero.com/api.xro/2.0/Invoices` ([Invoices](https://developer.xero.com/documentation/api/accounting/invoices)). Xero's own worked example for a receipt-derived bill ([Creating invoices best practice](https://developer.xero.com/documentation/best-practices/data-integrity/creating-invoices)):

```json
{ "Invoices": [ {
  "Type": "ACCPAY",
  "Contact": { "Name": "YMF Car Parts" },
  "LineAmountTypes": "Inclusive",
  "LineItems": [ {
      "AccountCode": "325",
      "Description": "Plate Set Rear Number",
      "Quantity": "1.0",
      "TaxType": "INPUT2",
      "UnitAmount": "16.2" } ],
  "Url": "https://app.mycompany.com/receipts/23456112",
  "CurrencyCode": "GBP",
  "DateString": "2025-08-06",
  "Status": "SUBMITTED",
  "InvoiceNumber": "TUK-O176045"
} ] }
```

- **`Type: "ACCPAY"`** = a bill (`ACCREC` = sales invoice).
- **`Status`:** `DRAFT` (no journals) → `SUBMITTED` ("Awaiting Approval", **still no journals**) → `AUTHORISED` (**journals created, hits the reports**) → `PAID` / `VOIDED`. `AUTHORISED` cannot go back to `DRAFT`.
- **`LineAmountTypes`:** `Exclusive` | `Inclusive` | `NoTax`. **If omitted, Invoices default to Exclusive but Receipts and Bank Transactions default to Inclusive and Manual Journals to NoTax.** Never rely on the default — always send it explicitly.
- **`AccountCode`** must be an ACTIVE, non-system code from a `GET /Accounts` on that tenant. Never hard-code.
- **`TaxType`** is the code, not the name. UK codes: `INPUT2` (20% expenses), `RRINPUT` (5%), `ZERORATEDINPUT`, `EXEMPTINPUT`, `NONE`, `REVERSECHARGES`, `ECACQUISITIONS`, `CAPEXINPUT2` ([Types](https://developer.xero.com/documentation/api/accounting/types)). Custom rates appear as `TAX001`, `TAX002`…
- **If you omit `TaxType`, Xero uses the default tax rate on the account code** — a safe, certification-blessed fallback. "Rely on Xero to calculate the tax" is explicitly *"our best practice"*.
- **`Url`** — *"URL link to a source document – shown as 'Go to [appName]' in the Xero app."* **This is a second, free D43 mechanism**, putting a clickable button on the bill inside Xero pointing back at the Neoting document.
- **ACCPAY does not support discounts**; `InvoiceNumber` on ACCPAY is **non-unique** and renders as "Reference" in the UI (max 255).
- **Batch up to 50** per call, and **use `?summarizeErrors=false`** so each entity returns its own status rather than failing the whole batch opaquely. *(This maps precisely onto Neoting's existing "a per-item failure is a RESULT, not a throw" rule — see §4.1.)*
- **Once part- or fully paid**, an ACCPAY bill is near-frozen; **nothing in a locked period is editable at all**.

##### ✅ D43: can Xero attach the source file to the transaction? **Yes — definitively.**

```
POST https://api.xero.com/api.xro/2.0/Invoices/{InvoiceID}/Attachments/{FileName}
Authorization: Bearer <token>
xero-tenant-id: <tenantId>
Content-Type: image/png            ← the real MIME type
Idempotency-Key: <key>
<RAW BYTES>
```

Confirmed in Xero's [official OpenAPI spec](https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml): body is `application/octet-stream`, security scope **`accounting.attachments`**, `idempotencyKey` header present on POST and PUT.

| Question | Answer |
|---|---|
| **How many per object?** | **10 attachments per document** |
| **Max size?** | **10 MB each** |
| **Which objects?** | Invoices, Receipts, Credit Notes, Repeating Invoices, Bank Transactions, Bank Transfers, Contacts, Accounts, Manual Journals, Purchase Orders, Quotes |
| **Allowed MIME types?** | **Not restricted by the Attachments endpoint** — you set `Content-Type` and Xero echoes it as `MimeType`. **An exhaustive allowlist is not verified** (the Xero Central page is behind bot protection). Assume PDF/JPEG/PNG are safe; test anything exotic. |
| **Filename restrictions** | These are **rejected as Bad Request**: space, `:`, `"`, `/`, `\`, `|`, `?`, `*`, `\0`, `+`. Brackets must be URL-encoded; all other characters left unencoded. |
| **Read back** | `GET .../Attachments/` returns `{AttachmentID, FileName, Url, MimeType, ContentLength}` |

Source: [Attachments API](https://developer.xero.com/documentation/api/accounting/attachments).

**Recommended D43 sequence per approved document:** `POST /Invoices` (with `Url` deep-link + `Idempotency-Key`) → capture `InvoiceID` → `POST /Invoices/{InvoiceID}/Attachments/{cleanFilename}` with the original bytes and its own key → persist `InvoiceID` + `AttachmentID` against the Neoting document record. **This gives Neoting both rungs at once: a real file attachment *and* a clickable deep link back to the source — strictly better than the four-rung ladder D43 designed for VT's file-based export.** Note it is **two API calls per document** against a 5,000/day/tenant ceiling (§1.1.7): ~2,000 documents/day per client org, comfortable for steady state, but a historical backfill needs planning. Note also that **Xero itself is "designed for volumes of up to 5,000 Purchases bills per month"** per organisation.

##### Idempotency — verified

Header **`Idempotency-Key`**, on **POST, PUT and PATCH only** ([Idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency)). Verified against the OpenAPI spec as accepted on `POST /Invoices`, `PUT /Invoices`, `POST /Invoices/{InvoiceID}` and the attachment endpoints. **Since when? Not verified** — Xero publishes no launch date. Listed as *"Recommended"* (not Required) in the certification matrix.

> ⚠ **Keys expire after 6 minutes.** *"keys are stored for 6 minutes from the time of the first call, after which they expire."* **This is a network-retry safety net, not a durable dedupe key.** Neoting must keep its own document-level dedupe — which it already has, in `publishes.idempotency_key` (proposal id + document id). Use that value *as* the Xero key, but never rely on Xero to enforce it beyond six minutes.

Other rules: max 128 characters; reusing a key with a *different* request → 400; **errors are cached too** (*"If an idempotent request errors out internally, the error will be cached and returned when the request is re-run even if the internal error is resolved"* — recovery is a GET to check existence then retry with a **new** key); idempotency is evaluated **after** rate limiting, so duplicates still burn quota.

##### 💷 Money-as-decimal: every conversion boundary

> **Neoting stores integer pence. Xero's wire format is IEEE-754 double.** Xero's [OpenAPI spec](https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml) declares **98 fields** as `type: number, format: double, x-is-money: true` — including `UnitAmount`, `LineAmount`, `TaxAmount`, `Quantity`, and at invoice level `SubTotal`, `Total`, `TotalTax`, `AmountPaid`, `AmountDue`, `CISDeduction`. **Every generated Xero SDK will hand you a float.** This is the single largest conversion-risk surface in this document.

| # | Boundary | Rule | Mitigation |
|---|---|---|---|
| 1 | `UnitAmount` outbound | **2 dp by default**; opt into 4 dp with `?unitdp=4` | Serialise from pence yourself as a fixed-2dp string; never let a float formatter do it |
| 2 | Summary values | *"All summary values such as Total, LineAmount etc will remain at two decimal places only"* even with `unitdp=4` | Don't expect 4dp totals back |
| 3 | Tax calculation | **Per line, rounded to 2 dp, then summed.** Rates may be 4 dp; the *amount* per line is 2 dp | Replicate Xero's per-line rounding exactly or you will diverge |
| 4 | Tax-inclusive maths | "adding the tax rate to 1 and dividing the rounded line total by the rate, rounding to two decimal places then subtracting" | Order of operations matters — a naive inclusive calc gives different pence |
| 5 | **Read-back** | Xero returns `Total`, `SubTotal`, `TotalTax` as JSON doubles | ⚠ **Never `float * 100`.** Parse the raw JSON token as a decimal string → pence, with a parser that preserves the literal |
| 6 | Rounding line | If you diverge, post to `SystemAccount: "ROUNDING"` (default code 860 — **GET Accounts to confirm, users change it**) | Neoting must model a pence-level rounding adjustment line |
| 7 | `TaxAmount` override | Possible but *"not recommended"*; **`TaxAmount` cannot exceed `UnitAmount`** | Avoid; let Xero compute |
| 8 | Hard cap | `LineAmount` can't exceed 9,999,999,999.99 | Validate before send |
| 9 | Dates | JSON returns `"\/Date(1439434356790)\/"` — **milliseconds** since epoch | Same class of parsing bug. Use `DateString`/`DueDateString` (`YYYY-MM-DD`) inbound |
| 10 | Multicurrency | `CurrencyRate` for non-base currency | **Required certification item even if you think you're GBP-only** |

**Discipline to adopt:** treat every money field as a **decimal string** at the HTTP boundary in both directions; convert string ↔ pence with an exact decimal type; never allow a `float` into the pipeline; never round-trip through the SDK's typed model for values you intend to store. This is the Xero-side sibling of `exports-public-api/canonical/money.ts`, and it should be written with the same care.

#### 1.1.7 Rate limits and quotas

All figures from [OAuth 2.0 API limits](https://developer.xero.com/documentation/guides/oauth2/limits/).

| Limit | Value | Scope |
|---|---|---|
| **Concurrent** | **5 calls in progress at once** | per tenant |
| **Minute** | **60 calls per minute** | per tenant |
| **Daily** | **1,000/day (Starter)** · **5,000/day (Core and above)** | per tenant |
| **App Minute** | **10,000 calls per minute** | **across all tenants, app-wide** |
| Request size | **10 MB** max | per request |
| Batch guidance | ~**50 nodes** per request | per request |

⚠ **A doc inconsistency:** the same page says both *"the maximum request size limit for all APIs is 10MB"* and, in its FAQ, *"a ceiling of about 50 nodes per request is practical – this will ensure a request does not exceed the maximum size of 3.5MB."* **Design for ≤3.5 MB to be safe.**

**Headers on every response:** `X-DayLimit-Remaining`, `X-MinLimit-Remaining`, `X-AppMinLimit-Remaining`. **On breach: HTTP 429** plus `X-Rate-Limit-Problem` naming which limit you hit, and **`Retry-After`** in seconds for minute/daily breaches. Windows are **fixed and reset at different times for each tenant** — *"It is important to use the Retry-After header."*

The concurrent/minute/daily trio is **per tenant**, so limits scale with customers. **The 10,000/min app-wide ceiling is the one that constrains a fleet:** at ~200 practices × 200 clients you share 10,000 calls/minute across 40,000 tenants. **Design the worker for tenant-fair scheduling from the start.**

**Rapid Sync** lifts the day and minute limits (not concurrency, not app-minute) for the **first 30 minutes of a new connection** — available to **certified apps from Plus upward**, enabled by your Partner Manager. ⚠ While active, `X-DayLimit-Remaining` and `X-MinLimit-Remaining` **stay pinned at full**; a throttler that reads those headers will misbehave.

**One field-level surprise:** Xero organisations on the **Early/Starter plan can only enter 5 approved Accounts Payable invoices per month**, returning HTTP 400 *"You have reached the limit of invoices you can approve."* Judged on **invoice date, not creation date**. For a product whose whole purpose is posting purchase invoices for small clients, **expect to hit this regularly** and surface it as a clear, actionable message rather than a generic failure.

#### 1.1.8 Sandbox and test access

**There is no dedicated sandbox environment.** You develop against production API hosts using a **Demo Company** ([Development accounts](https://developer.xero.com/documentation/development-accounts)).

| | **Demo Company** (recommended) | **Trial organisation** |
|---|---|---|
| Cost | Free | Free 30 days, then billing info |
| Data | **Pre-populated with dummy data** | Empty |
| Reset | **Resets automatically after 28 days** | Cannot be reset |
| Country | **Switchable** (switching resets it) | Fixed |
| Other users | Cannot invite others | Can invite |

**One demo company per Xero login**, switchable by region — to run several in parallel, use several Xero logins. **Not verified** whether Xero offers higher-volume test-org provisioning, though the certification matrix mentions *"You may need to provision a test account for us"* for the reviewer. ⚠ **Your app must reconnect after every 28-day demo reset** — bake it into the dev runbook.

Other tooling: the [API Explorer](https://api-explorer.xero.com/), official [Postman](https://developer.xero.com/documentation/sdks-and-tools/tools/postman) and Insomnia collections, and [SDKs](https://github.com/XeroAPI). For granular scopes: *"any new test app you create will use granular scopes by default."* For **Bulk Connections** and **Rapid Sync**, a test version can be enabled for your test app by a Developer Evangelist.

#### 1.1.9 Costs

**Developer programme fee: £0 to start.** Starter is free with **unlimited API data egress**.

| | Starter | Core | Plus | Advanced | Enterprise |
|---|---|---|---|---|---|
| **Connections (max)** | 5 | 50 | 1,000 | 10,000 | No limit |
| **Monthly tier fee** | **Free** | **A$35** | **A$245** | **A$1,445** | POA |
| API **ingress** (writes into Xero) | Unlimited | Unlimited | Unlimited | Unlimited | Unlimited |
| API **egress** allotment | n/a | 10 GB | 50 GB | 250 GB | POA |
| **Egress overage** | n/a | **A$2.40/GB** | A$2.40/GB | A$2.40/GB | POA |
| Daily rate limit | 1,000/day/org | 5,000/day/org | 5,000 | 5,000 | 5,000 |
| Rapid Sync | ✗ | ✗ | ✓ | ✓ | ✓ |
| Journals / XPM / **Bulk Connections** | ✗ | ✗ | ✗ | **✓** | ✓ |
| Developer support | General | General | General | Priority | Priority |

*Prices quoted in **AUD**, **tax exclusive**. A GBP price list is **not published** — not verified.*

- **App Store revenue share: 0%.** The 15%-of-ARPU referral fee is retired.
- **Listing fee: none.** **Certification cost: none directly.** **Security assessment: none charged** (self-assessment); your cost is remediation engineering time.
- Egress is measured in GiB but displayed as "GB". **`GET /Organisation` is excluded from the allotment** — Xero exempted it deliberately, so use it for free liveness checks.
- Billing: card charged on the 1st of the following month, **per app**. **Apps cannot pool connections or egress**, even under one developer account.
- Tier moves must be **applied for**; downgrades are limited to **twice per year** via support.
- ⚠ **Neoting is not exempt.** Xero exempts *"Bespoke Integrations for Accountant and Bookkeepers built for your own practice or a single client"* — a multi-tenant product sold to many practices does not qualify.

**Cost shape for Neoting:** the **connection ceiling, not byte volume**, forces tier moves. Neoting's traffic is ingress-heavy (writing bills) and **ingress is unlimited at every tier**. Egress is chart-of-accounts, tax-rate, contact and bank reads — cache those and 50 GB/month at Plus is generous. **Budget A$245/mo at a few hundred client orgs, A$1,445/mo once you need Bulk Connections or pass 1,000 orgs.**

#### 1.1.10 Timeline to first write into a real client's ledger

**You can write into a real client ledger within weeks. Certification is not on that critical path — it is on the path to scale.**

| Milestone | Elapsed | Gate |
|---|---|---|
| Dev account + app registered + demo company | **Same day** | none |
| Working ACCPAY POST + attachment on demo | ~1–2 weeks eng | none |
| **First real client organisation, live** | **Week 2–3** | **none — 5 connections are free** |
| 50 client organisations | +1 day | add a credit card → Core |
| 10 active connections + Sign Up with Xero built | ~1–3 months | prerequisite for certification |
| **Certification review completed** | **Not published by Xero.** Treat as **weeks, not days**, with at least one remediation round. **Not verified.** | Developer Evangelist |
| **Plus tier — 1,000 organisations** | | certification passed |
| Security self-assessment (issued at 800 connections) | **5 working days** to complete + **5–10 working days** for Xero to assess | published |
| Remediation if needed | **30 days** for a plan + **60 days** to implement | published |
| **Advanced — Bulk Connections, 10,000 orgs** | | certification + security assessment + **use-case approval** |

**Honest read:** Neoting is writing to a real UK practice's client ledger in **2–4 weeks of engineering** *once the shared OAuth layer of §4.3 exists*. It is *certified and past 50 organisations* in a realistic **3–6 months**, dominated by building Sign Up with Xero, mapping UI, error surfacing, multicurrency and rounding to certification standard, plus Xero's own review cadence. **Bulk Connections — the feature that makes onboarding a 200-client practice tolerable — is the long pole:** certification + security assessment + use-case approval + A$1,445/mo. **If practice-scale onboarding is core to the pitch, open that conversation with a Developer Evangelist early rather than discovering the gate at scale.**

#### 1.1.11 Does Xero require explicit user action for ledger writes?

**No — there is no rule that a human must press a button before your app writes.** But four adjacent rules interact with Neoting's Approve gate, and the interaction is favourable:

1. **Xero permits either model and requires only that it be clear.** From [Creating invoices best practice](https://developer.xero.com/documentation/best-practices/data-integrity/creating-invoices): *"It's important that it is clear to the user when and how the invoice(s) will be sent to Xero… Should the invoice creation in Xero happen automatically or be triggered by the user? Whichever option you decide works best, ensure this is clear to the user."* **Neoting's server-enforced Approve gate is compliant and exceeds the bar. Lead with it in the certification submission.**
2. **Consent is per-scope and per-tenant and cannot be silent.** Scope changes always require a fresh OAuth round-trip.
3. **You may not simulate user actions.** API writes are fine; browser automation of the Xero UI is not.
4. ⚠ **Where the Approve gate must be reflected in the payload.** Xero's status model *is* the ledger's own approval gate: `DRAFT` and `SUBMITTED` create **no journals**; only `AUTHORISED` posts. Neoting should map its human Approve to the transition into `AUTHORISED` — **and should offer the practice the choice**, since Xero explicitly supports *"a dropdown, for the user to select the default invoice status used when creating invoices"* and many practices want a second review inside Xero. Note `AUTHORISED` is close to a one-way door: it can only go to `VOIDED`, never back to `DRAFT`.
5. Reciprocally, **subscribe to invoice webhooks** so that when a bill is approved or paid *in Xero*, Neoting marks its own record read-only. Webhooks are a **Required** certification item.

#### 1.1.12 Quick reference — decisions Xero forces on Neoting

1. **Register the app now.** It is free, and the 5 free connections cover an entire pilot.
2. **Request granular scopes.** Do **not** build on `accounting.transactions`; it dies September 2027.
3. **Key the token store on `xero_userid`, not tenant**, and handle refresh rotation with the 30-minute grace window as a first-class recovery path.
4. **Run a scheduled refresh sweep across all tenants every <60 days**, independent of user activity, storing a computed `refresh_token_expires_at`.
5. **Validate `xero-tenant-id` on every call path.** Cross-tenant leakage is the failure mode Xero warns about by name and places entirely on you.
6. **Never let a float touch money.** 98 spec fields are `format: double`.
7. **D43 is fully solvable** — attachment *and* clickable `Url` deep link.
8. **`Idempotency-Key` is a 6-minute safety net, not your dedupe.**
9. **Budget the Advanced tier** if practice-scale onboarding matters.
10. **Check whether pilot client orgs already have two uncertified apps connected** — if so, Neoting cannot connect until certified.
11. **Ledger and cashbook client organisations are effectively out of scope.** Size that share before pricing.
12. **You cannot train models on Xero API data.** Audit the pipeline for this before applying.

**Primary sources:** [Pricing & tiers](https://developer.xero.com/pricing) · [Pricing FAQs](https://developer.xero.com/faq/pricing-and-policy-updates) · [API limits](https://developer.xero.com/documentation/guides/oauth2/limits/) · [Tenants](https://developer.xero.com/documentation/guides/oauth2/tenants) · [Auth flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/) · [Token types](https://developer.xero.com/documentation/guides/oauth2/token-types) · [Scopes](https://developer.xero.com/documentation/guides/oauth2/scopes) · [Granular scopes FAQ](https://developer.xero.com/faq/granular-scopes) · [Certification checkpoints](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/certification-checkpoints) · [Certification matrix](https://developer.xero.com/documentation/best-practices/overview/cert-matrix) · [App partner features](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/app-partner-features) · [Security standard](https://developer.xero.com/partner/security-standard-for-xero-api-consumers/) · [Security requirements FAQ](https://developer.xero.com/faq/xero-ecosystem-security-requirements-update) · [Invoices API](https://developer.xero.com/documentation/api/accounting/invoices) · [Attachments API](https://developer.xero.com/documentation/api/accounting/attachments) · [Types](https://developer.xero.com/documentation/api/accounting/types) · [Idempotency](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency) · [Rounding](https://developer.xero.com/documentation/best-practices/data-integrity/rounding) · [Creating invoices](https://developer.xero.com/documentation/best-practices/data-integrity/creating-invoices) · [Multi-tenancy](https://developer.xero.com/documentation/best-practices/managing-connections/multi-tenancy) · [Development accounts](https://developer.xero.com/documentation/development-accounts) · [Commercial Terms](https://developer.xero.com/xero-developer-platform-commercial-terms) · [Xero OpenAPI spec](https://github.com/XeroAPI/Xero-OpenAPI)
### 1.2 QuickBooks Online (Intuit)

> **Research date: 3 September 2026.** Intuit changed its commercial model materially in 2025–26 (§1.2.9). Figures marked ⏱ are the most likely to move.

**Three headline findings that should reshape the plan:**

1. **Production access is *not* gated on the App Store review.** It is gated on a **self-attested App Assessment Questionnaire** that Intuit approves. Once approved you can write to real client ledgers privately — no marketplace listing, no technical review, no security scan. **For a tool sold directly to UK practices this is the fast path.**
2. ⚠ **Reads are now metered; writes are free.** Since 3 November 2025 in the UK, `POST` writes are "Core" (unmetered) and *every* `GET`, `/query`, `/cdc`, all reports **and `POST /batch`** are "CorePlus" (metered). **A document-to-bookkeeping pipeline is read-heavy by nature.** This is the dominant cost driver and it must shape the architecture from day one.
3. **The "sandbox is US-only" assumption is wrong.** You *can* create UK and AU sandbox companies with region-correct VAT/GST sample data — but you get only 10 sandboxes total and region cannot be changed after creation.

#### 1.2.1 Application path, step by step

| # | Step | Where | Gate |
|---|---|---|---|
| 1 | Create Intuit Developer account | `developer.intuit.com/app/developer/myapps` | none |
| 2 | Create app, **choose scopes** | App dashboard | none — but scopes can be *added* later, **never removed** |
| 3 | Get **Development** keys | Keys and credentials → Development | none, immediate |
| 4 | Create sandbox companies (**pick the region!**) | Sandbox section | max 10 |
| 5 | Build + test against sandbox | — | — |
| 6 | Fill **App Details for Production** (~30 min) | Keys and credentials → Production | EULA URL, Privacy Policy URL, host domain, launch/disconnect/connect URLs, categories, hosting regions |
| 7 | **Complete App Assessment Questionnaire** | Production → Compliance → Start Questionnaire | **← THE GATE** |
| 8 | Get **Production** keys | Production → Show Credentials | *appears only after questionnaire approval* |
| 9 | *(optional)* List on QuickBooks App Store | Marketplace tab | 3-part review + paid tier |

The gate is documented twice and unambiguously:

> "The client ID and client secret will be accessible only after completing the **Production Key questionnaire and its approval**." — [Get the Client ID and Client Secret](https://developer.intuit.com/app/developer/qbo/docs/get-started/get-client-id-and-client-secret)
>
> "Note: The **Show Credentials** switch appears only after the **App Assessment Questionnaire is approved**." — [Publish your app](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app)

The questionnaire is **self-attested but human-approved**: *"To publish an App, you must first complete a self-attested assessment questionnaire. Upon approval, your App moves to production"* ([App Partner Program Guide v1.2, 03.2026](https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf), p.6). **The approval SLA is not published — not verified.**

> **Critical distinction — "publish" ≠ "list".**
> **Publish** = obtain production keys; the app is live and *"You can share the URL with other developers or users so they can access it, keeping it semi-private."*
> **List** = public marketplace listing, requiring the 3-part review **and a paid tier**. *"If you don't want to list your app to the QuickBooks App Store, you're free to market your app privately and skip the review."* ([List your app](https://developer.intuit.com/app/developer/qbo/docs/go-live/list-on-the-app-store))
>
> **For Neoting, selling directly to UK practices, private production is the right first destination.**

#### 1.2.2 What Intuit demands of the applicant company

Required for **production keys** ([Publish your app](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app), [Publishing requirements](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app/platform-requirements)):

| Item | Required? | Notes |
|---|---|---|
| Registered company details + domicile address | **Yes** | Sets contracting entity, governing law and billing currency |
| Public website | **Yes** | Your logo top-of-page, **larger** than any Intuit mark; URL must contain **no Intuit brand element** |
| Privacy policy URL | **Yes** | Publicly accessible, **not behind a login** |
| Terms of service URL | **Yes** | Same |
| **EULA URL** | **Yes** | A **separate** mandatory field — note this is a *fourth* legal document beyond the three in `docs/legal/` |
| Support contact | **Yes** | Email or phone minimum |
| Named security contact | **Not verified** | No such field found; compliance mail goes to the app-registration email — use a monitored shared mailbox |
| Pen-test evidence | **Not upfront** | On request only (below) |
| SOC 2 / ISO 27001 | **No** | Neither appears in Intuit's published requirements. Commercially useful for selling to practices, but not an Intuit gate |
| **Insurance** | **Yes, contractually** | See below |
| Uptime | **99.95%, 24/7** | **Applies to private apps too** |

**Third-party security review — two separate mechanisms:**

1. **On-request, always in force** ([Security requirements](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app/security-requirements)): allow Intuit to run vulnerability scans **within 2 weeks of request**, *or* supply *"reputable scan results… conducted within the last year"*; complete a **security affidavit within 2 weeks**; remediate promptly. **Intuit may reject your scan results.**
2. ⚠ **Annual third-party review** — triggered for *"all apps listed on the app store, **and any app with over 500 connections**"*. **A practice-facing app connecting to hundreds of client realms will cross 500 connections and be pulled into annual third-party security review whether or not it is ever listed.** Build to the security requirements now, not under a two-week clock later.

**Prescriptive security requirements to design to:** TLS 1.2+; `Cache-Control: no-cache, no-store` (**not** `private`) on sensitive pages; `TRACE` disabled; session cookies `Secure` + `HTTPOnly`; **encrypt and store refresh token + realmID at rest**, AES preferred (docs say "store your AES key in a separate configuration file" — dated wording; **whether a KMS/HSM satisfies a reviewer is not verified**, worth pre-clearing); **"You must not log any user's credentials or QuickBooks data"** but you *must* log `intuit_tid` (so scrub payloads, keep correlation IDs); endpoints receiving tokens in URL params must **302 redirect**; tested against CSRF, XSS, SQLi, XML injection, access control and open redirects.

> ⚠⚠ **The clause that is Neoting's least-charted risk.** Intuit requires that *"Your app does not provide third-parties with access to a customer's QuickBooks data, via external API calls or any other means"* and that you *"cannot export, save, or store QuickBooks data for any purpose other than the functional use of your app."*
>
> **Read this against sending document content or QBO data to a third-party LLM API.** No published Intuit carve-out for AI subprocessors was found — **not verified**. Expect the question in the questionnaire, and be ready with a subprocessor chain, zero-retention contractual terms, and a data-flow diagram. **Note that MYOB has addressed exactly this scenario explicitly (§1.6) while Intuit has not — so Intuit's silence is ambiguity, not permission.**

**Insurance — required, and frequently missed.** Developer TOS §20.4: maintain, at your expense, **professional liability, cyber liability and general liability** cover during the term **and for three years afterwards**. No minimum limits are stated and no certificate is filed, but the obligation is unambiguous and survives termination. Note the asymmetry: §17 makes you indemnify Intuit for a security incident, while **Intuit's liability to you is capped at US$500** (§16).

⚠ **Breach notification: 24 hours to Intuit** (Developer TOS §13.4) — **tighter than UK GDPR's 72 hours to the ICO**, so the incident runbook must be written to the shorter clock. Remediation SLAs by Intuit's classification: Immediate 7 days / High 30 / Medium 90 / Low 1 year.

**Data residency:** no mandated location, but you must **declare** hosting countries. UK/EU transfers must use an adequacy decision or approved transfer mechanism (TOS §12.5). **You are an independent controller, not Intuit's processor** — your DPA with the practice is your own problem (which `docs/legal/data-processing-terms.md` addresses).

**UK contracting party:** Intuit Limited, 5th Floor Cardinal Place, 80 Victoria Street, London SW1E 5JL; governing law England & Wales. **Australia:** Intuit Australia Pty Limited; NSW law; disputes by **ICC arbitration seated in Sydney**. ([Developer TOS](https://developer.intuit.com/app/developer/qbo/docs/legal-agreements/intuit-terms-of-service-for-intuit-developer-services))

> ⚠ **Naming constraint — check this before finalising branding.** You may not use "QuickBooks", "QB", "QBO", "QBOA", "ProAdvisor", "Intuit", **or brand elements such as "quick", "intui", "tuit", including phonetic equivalents ("qwik", "QuBee")** in your business or product name. The only permitted relationship phrase is *"Member: Intuit Developer Program"* ([Naming and logo guidelines](https://developer.intuit.com/app/developer/qbo/docs/go-live/list-on-the-app-store/naming-and-logo-guidelines)). *"Neoting" and "Neo Accounting" are clear of this.*

#### 1.2.3 App review and marketplace listing

| | Production keys | App Store listing |
|---|---|---|
| Gate | App Assessment Questionnaire | Questionnaire **+** technical **+** security **+** marketing review |
| Tier required | Builder (free) | **Silver minimum** |
| Intuit SSO required | No | **Yes**, for QBOA visibility |
| Cost | £0 | **£225/mo** (UK Silver) ⏱ |

**The three-part review is strictly serial** ([What to expect](https://developer.intuit.com/app/developer/qbo/docs/go-live/list-on-the-app-store/what-to-expect-during-the-review)):

| Stage | Documented time |
|---|---|
| Kickoff email to schedule a call | within **2 business days** of submission |
| Technical review | **10 business days** after you confirm readiness (elsewhere stated as ~20 days average — **the docs conflict**) |
| Security review (**third-party vendor**) | **up to 30 business days** from scan start (elsewhere ~7 days average — **docs conflict**) |
| Marketing review | **5 business days** after security approval |

You must remediate **all critical, high and medium** findings before publication. **Realistic planning number: 6–12 weeks with one remediation round.**

**Common rejection reasons** ([Common reasons](https://developer.intuit.com/app/developer/qbo/docs/go-live/list-on-the-app-store/common-reasons-for-rejection)): "Get App Now" doesn't reach the SSO page; users can't request a trial or demo; **users can't find the QuickBooks integration settings inside your app** (*"This is a common reason for rejection"*); data flow doesn't work; missing or outdated "Connect to QuickBooks" button or logo. Marketing adds: abbreviating to "QB"/"QBO", missing trademark notice, unverifiable claims, **any reference to an Intuit competitor**.

> **⚠ REVENUE SHARE: there is none — a verified negative.** The strings "revenue", "commission", "royalty" and "%" do not appear in the Program Guide, and the Developer TOS grants licences expressly **"royalty-free"**, the only fee clause being §5 Platform Service Fees. **No listing fee either** — but listing requires a paid tier, so effectively £225/mo.

**Accountant-ready — essential for Neoting.** Apps do **not** automatically appear in QuickBooks Online Accountant. You must implement **Intuit SSO via OpenID Connect**, map connections by `realmID`, and tick *"Is your app QuickBooks Online Accountant ready" → Yes*. Detect QBOA via the `entitlements` entity ([Make your app accountant-ready](https://developer.intuit.com/app/developer/qbo/docs/go-live/list-on-the-app-store/make-your-app-accountant-ready)). ⚠ Technical requirements §6 also demands **a page listing every connected company with per-company disconnect and an "Add new company" button** — which is precisely the connection-management surface §4.2 identifies as missing, and it is **not cheap to retrofit**.

**QSP / ProAdvisor.** The **QuickBooks Solution Provider** programme is explicitly *"a separate program"* from the App Partner Program — a **reseller/referral** motion, US-facing; **UK availability not verified**. **Not a route to API access.** **ProAdvisor** is free and for accountants, not ISVs — but **ProAdvisors are Neoting's buyer**, and the way to reach them is SSO + Accountant-ready + a listing.

#### 1.2.4 ⚠ Limits before production

| Question | Answer |
|---|---|
| Sandbox companies per developer account | **Maximum 10** |
| Sandbox validity | **2 years**, then must create new (cannot renew) |
| What development keys connect to | **Sandbox companies only** |
| **Production companies an unlisted app may connect to** | **No documented cap.** Once the questionnaire is approved, production keys work against real companies without a company-count limit |
| "Connect to N production companies before review" cap | **Not verified — no such cap found in official docs.** Do not plan around a number here |

Source: [Sandbox FAQ](https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/sandbox-faqs).

> **This is the single biggest structural difference from Xero.** Xero caps an uncertified app at **5 connections**; **Intuit caps nothing once the questionnaire is approved.** For a practice serving 200 clients, that is the difference between a pilot that can run and one that cannot.

The real thresholds that bite are consequences, not gates:

| Threshold | Consequence |
|---|---|
| **>500 active connections** | Pulled into **annual third-party security review**, listed or not |
| **≥500 active connections** | Eligible for **Gold** tier |
| **≥3,000 active connections** | Eligible for **Platinum** tier |

An "active connection" = one QBO company with an active subscription and a valid, non-expired OAuth token. **Connections aggregate across all production apps in a Workspace.** Eligibility checkpoints run twice a year (31 Jan, 31 Jul) ([Program Guide](https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf) p.6–7).

#### 1.2.5 Auth model

OAuth 2.0 authorization code flow, optionally with OpenID Connect. Authorization `https://appcenter.intuit.com/connect/oauth2`; token `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`.

| Scope | Grants |
|---|---|
| `com.intuit.quickbooks.accounting` | Accounting API — **the only one Neoting needs** |
| `openid` (+ `profile`, `email`) | OpenID Connect — **required for Intuit SSO / QBOA visibility** |
| `indirect-tax.tax-calculation.quickbooks` | Sales Tax API (**premium — Silver tier minimum**) |

⚠ **Scopes can be added but never removed from an app.** Any scope change forces every user through re-authorisation.

**Token lifetimes** ([OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0), [FAQ](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/faq)):

| Property | Value |
|---|---|
| Access token | **3,600 s (1 hour)**; max 4,096 chars; expired → HTTP 401 |
| Refresh token | **100 days, rolling** — extended on each use |
| Refresh token **value rotation** | **Every 24 hours** (or the next refresh after 24 h). The previous value expires immediately. Max 512 chars |
| Refresh token **hard cap** | **5 years** (`x_refresh_token_hard_expires_in`), regardless of rolling extension |
| Idle expiry | Unused for 100 days → dead; user must reauthorise from scratch |

> ⚠ **Two operational traps for a practice app with hundreds of realms.**
>
> **1. The 100-day idle clock is per realm.** A practice with 300 clients will have quiet realms — dormant clients, seasonal work, year-end-only files. **Every one of them silently dies at day 100** and needs the practice admin to walk the consent flow again. You need a **keep-alive job refreshing every realm inside 100 days** (cheap — OAuth endpoints are unmetered), plus proactive expiry alerting in the practice-facing UI. The 5-year hard cap means even perfectly maintained connections must eventually be re-consented — diary it.
>
> **2. Concurrent refresh will revoke your tokens.** *"Only exchange access tokens one at a time. If two attempts are made… the first attempt will succeed but the second will return `invalid_grant`. Our servers may see this as a possible security issue and **revoke your refresh tokens for the first successful call**."* With hundreds of realms and parallel workers this **will** happen. **Mandatory: a per-realm distributed mutex around token refresh**, single-flight semantics, and always persist the newest token from the most recent response.

**Per-realm connection management:** map `realmID` → your tenant (Neoting's `Integration.orgRef`). `realmId` arrives as a query parameter on the redirect URI and can be echoed on your disconnect URL. On user disconnect you must call the revoke endpoint.

#### 1.2.6 The API surface

**Creating a Bill** — `POST /v3/company/<realmID>/bill` ([Bill entity](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/bill)):

| Field | Status | Notes |
|---|---|---|
| `VendorRef` | **Required** | |
| `Line[]` | **Required** | `AccountBasedExpenseLineDetail` for coded expense lines |
| `…AccountRef` | account code | from the Account list |
| `…TaxCodeRef` | VAT/GST code | **per line** |
| **`GlobalTaxCalculation`** | **Conditionally required** | *"Not applicable to US companies; **required for non-US companies**"* — i.e. **mandatory for UK and AU**. Values: `TaxExcluded`, `TaxInclusive`, `NotApplicable` |
| `DocNumber` | Optional, ≤21 chars | **rejects duplicates** — see idempotency below |
| `PrivateNote` | Optional, ≤4,000 chars | **a good home for the Neoting document code** |
| `TotalAmt` | **read-only** | *"Calculated by QuickBooks business logic; any value you supply is over-written"* |

Use **`Purchase`** instead of `Bill` for immediately-paid card/cash/bank spend; `Bill` for payables.

##### ✅ D43: can QBO attach the source file? **Yes — definitively.**

`POST /v3/company/<realmID>/upload`, `multipart/form-data`, pairing `file_metadata_NN` (JSON `Attachable` with `AttachableRef.EntityRef` = `{type:"Bill", value:"<id>"}`) with `file_content_NN` (the bytes). **Upload and link in one call** ([Attach images and notes](https://developer.intuit.com/app/developer/qbo/docs/workflows/attach-images-and-notes), [Attachable entity](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/attachable)).

| Question | Answer |
|---|---|
| **Request size limit** | **100 MB total.** *"An upload request may contain as many files as possible… but the overall request size must not exceed 100 MB."* **No per-file cap and no file-count cap documented — not verified** |
| **Attachments per transaction** | **10,000 max** |
| **Allowed types (exhaustive allowlist of 17)** | `ai`, `csv`, `doc`, `docx`, `eps`, `gif`, `jpeg`, `jpg`, `ods`, **`pdf`**, **`png`**, `rtf`, `tif`, `txt`, `xls`, `xlsx`, `xml`. Anything else → error **`6041` "Invalid Uploaded File"** |
| `Category` values | `Contact Photo`, `Document`, `Image`, **`Receipt`**, `Signature`, `Sound`, `Other` |
| Retrieval | `GET /v3/company/<realmID>/download/<attachableId>` returns a temporary URL that **expires in 15 minutes** |

> ⚠ **Confirming the brief's premise: there is NO URL/link field on `Attachable`.** Verified by field enumeration — `Id`, `SyncToken`, `FileName`, `Note`, `Category`, `ContentType`, `PlaceName`, `AttachableRef`, `Long`, `Tag`, `Lat`, `MetaData`, plus read-only `FileAccessUri`, `Size`, `ThumbnailFileAccessUri`, `TempDownloadUri`. **You must upload bytes — you cannot point QBO at a file you host.** Combined with the 17-type allowlist, **shortcut/link file types (`.lnk`, `.url`, `.webloc`) are effectively blocked**: there is no shortcut mechanism and no type that would carry one. This corroborates the finding already recorded in SoT D43.
>
> **Consequence for D43: unlike Xero (which has both a `Url` field and attachments), QBO gives you the attachment only.** The Neoting document code must therefore live in `PrivateNote` (4,000 chars, generous) as the text rung, with the real file attached as the primary rung.

⚠ Also note: *"the attachment/object relationship is established with the Attachable object, only; the object does not include a link back to the attachment."* To prove provenance you must query `select Id from attachable where AttachableRef.EntityRef.Type = 'bill' and AttachableRef.EntityRef.value = '<id>'` — **and that query is metered** (§1.2.9), so cache the assertion rather than re-querying.

**Ordering for D43:** create Bill (Core, free) → capture `Id` → upload+link the file in one multipart call (Core, free) → optionally verify with an Attachable query (CorePlus, metered).

##### ⚠ Idempotency: there is none

**No `requestid` query parameter, no idempotency key, and no replay-safe mechanism exists in the QuickBooks Online Accounting API.** The string `requestid` does not appear in the OAuth, REST-features, Bill, Purchase, Attachable, batch, minor-versions or limits documentation. `intuit_tid` is explicitly a **support/tracing** identifier only ([REST API features](https://developer.intuit.com/app/developer/qbo/docs/learn/rest-api-features)).

> **Your only server-side dedupe lever is `DocNumber`:** *"Throws an error when duplicate DocNumber is sent in the request."* (Override with `?include=allowduplicatedocnum`.)
>
> **Recommendation:** derive a deterministic `DocNumber` from the Neoting source-document identity and rely on QBO's duplicate rejection as the last line of defence, backed by Neoting's own idempotency ledger — which already exists as `publishes.idempotency_key` (§4.1) — written *before* the POST and reconciled after. **Treat a duplicate-DocNumber error as success-with-existing, not as failure.** That is a specific behaviour the `LedgerAdapter` implementation must encode.

**Batch:** `POST /v3/company/<realmID>/batch`, **max 30 payloads**, **no ordering guarantee**, **items cannot depend on each other**. (The [batch overview page](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/batch) says 10; the entity reference and limits page say 30 — **the docs conflict**.)

> ⚠ **Do not batch your writes.** `POST /batch` is classified **CorePlus (metered)** while individual `POST /bill`, `/purchase` and `/upload` are **Core (free)**. **Batching writes converts free calls into billable ones.** Batch only when combining *reads* that would be metered anyway. This inverts the usual instinct and is worth writing into the adapter's comments.

**Minor versions:** 1–74 were **discontinued 1 August 2025**; anything `<75` is served as 75. Pin explicitly ([Minor versions](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions)).

##### 💷 Money as decimal — every conversion boundary

QBO expresses **every** monetary value as a JSON decimal number.

| Field | Type / precision | Risk |
|---|---|---|
| `Line[].Amount` | Decimal, **2 dp** | Primary boundary |
| `Line[].*.UnitPrice` | Decimal, **7 dp** | See the double-rounding trap |
| `TotalAmt` | BigDecimal, **read-only** | **Your supplied value is silently overwritten** |
| `ExchangeRate` | Decimal | Multi-currency amplifies rounding |
| `TxnTaxDetail.TotalTax` / `TaxLine[].Amount` | Decimal | Computed by QBO unless overridden |
| `Attachable.Size` | **Decimal** (bytes) | Oddly typed; not money, but will surprise a strict parser |

**Three specific traps, all documented** ([Automated sales tax, non-US locales](https://developer.intuit.com/app/developer/qbo/docs/workflows/calculate-sales-tax/automated-sales-tax-for-non-us-locales)):

1. ⚠ **`UnitPrice` silently overrides `Amount`.** *"If both UnitPrice and Line.Amount are passed in, **the value in Line.Amount is discarded** and the calculated value is used instead."* → **Send `Line.Amount` only. Never send `UnitPrice` + `Qty` for an imported document.**
2. ⚠ **Double rounding via `UnitPrice`.** Intuit's own worked example: input `37.37499999` → saved `Line.Amount` **37.38**, tax @12% = **4.49**; the same figure passed directly as `Line.Amount` → **37.37**, tax = **4.48**. **A penny of divergence from one field choice.**
3. ⚠ **`TaxInclusive` rounds per line, not per total.** Intuit's example: one line of £20.00 incl. 20% → £3.33 tax; **five lines of £4.00 incl. 20% → £3.35 tax**. **Your gross total is identical and your VAT differs by 2p purely from how the document was split into lines.**

Rounding is half-up. **Recommended discipline for the Approve step:** convert pence → decimal with exact 2-dp construction (never float arithmetic); send `Line.Amount` only; on the response convert `TotalAmt` and `TxnTaxDetail.TotalTax` back to pence and **reconcile against the source-document totals before releasing**; treat any mismatch as a **hard failure that blocks release**, not a warning. Intuit polices this: *"Your app may be audited to ensure that your app does not miscalculate tax amounts or mess up customers' books."*

#### 1.2.7 Rate limits and quotas

From [Limits and throttles](https://developer.intuit.com/app/developer/qbo/docs/learn/limits-and-throttles) — **this supersedes the older "40 concurrent requests per app" figure, which no longer appears**:

| Limit | Sandbox | Production |
|---|---|---|
| REST requests/minute **per realmId** | **500** | **500** |
| REST requests/second **per realmId + app** | **10** | **10** |
| Combined limit incl. non-QBO Intuit endpoints | — | **800/min per realmId + app** |
| Batch requests/min per realmId + app | **40** | **40** |
| Batch requests/min per realmId | **120** | **120** |

Other ceilings: **request timeout 120 seconds**; **max 1,000 entities per query response**; max 10,000 line items, 10,000 linked transactions and 10,000 attachments per transaction.

**Throttled response: HTTP 429, and Intuit's instruction is to wait 60 seconds before retrying** — not exponential backoff from milliseconds.

> **The limits are per realm, which is good news for a practice app** — 500/min per client company means fan-out across hundreds of realms is not throttle-constrained. **The binding constraint is cost, not rate** (§1.2.9). Higher limits are **not purchasable**: *"access to higher throttling limits and enhanced API performance is not available."*

#### 1.2.8 Sandbox and test access

| Property | Value |
|---|---|
| Max sandboxes | **10** |
| Default | *"You automatically start with a **US-based** sandbox"* |
| **Regional sandboxes** | **✓ Available** — AU, CA, FR, IN, **UK**, US (QuickBooks Online **Plus**) |
| QBO **Advanced** sandbox | **US only** |
| Region/SKU changeable after creation | **No** — create a new one |
| Validity | **2 years**, unrenewable |
| Metering | **Sandbox calls are never metered or charged** |
| Not supported | Payroll, live bank feeds, import/export |

> ⚠ **Correcting the common trap: sandbox is US by default, not US-only.** The **UK** sandbox is a "Party Planning Services" company with 164 transactions and 80 accounts, pre-populated with UK VAT codes (`20.0% S`, `Exempt From VAT`). The AU sandbox is similar with GST codes.
>
> **Allocate your 10 deliberately:** at minimum 2× UK (one clean, one edge-case), 2× AU, 1× US, leaving headroom. **Create the UK ones first — you cannot change region later, and burning slots on US defaults is the actual trap.**

#### 1.2.9 ⚠ Costs — the Intuit App Partner Program

**This is new and it changes the business case.** Launched US 28 July 2025; **extended to the UK, Australia and Canada on 3 November 2025**. All apps are **auto-enrolled at Builder with no opt-out**. Tiers are per **Workspace**, and usage and connections aggregate across all production apps in a Workspace.

| | Builder | Silver | Gold | Platinum |
|---|---|---|---|---|
| **Monthly fee (US)** ⏱ | **Free** | **US$300** | US$1,700 | US$4,500 |
| **Monthly fee (UK)** ⏱ | **Free** | **£225** | not verified | not verified |
| Core API credits | Uncapped | Uncapped | Uncapped | Uncapped |
| **CorePlus credits/mo** | **500,000 (hard cap)** | 1 M | 10 M | 75 M |
| Overage 1M–10M (US / UK) | — | $3.50 / **£2.60** per 1k | Included | Included |
| Premium APIs | ✗ | ✓ | ✓ | ✓ |
| Marketplace listing | ✗ | Optional | Optional | Optional |
| Min. active connections | — | — | **500** | **3,000** |

Sources: [Partner tiers and pricing](https://developer.intuit.com/partners/benefits), [Program Guide](https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf), [Partner FAQ](https://developer.intuit.com/app/developer/qbo/docs/get-started/partner-faq) (last updated 2026-08-10).

**Core vs CorePlus** ([API classification](https://help.developer.intuit.com/s/article/API-classification-for-the-Intuit-App-Partner-Program), 4 Jun 2025):

| Core — **free, unmetered** | CorePlus — **metered** |
|---|---|
| `POST /bill`, `/purchase`, `/vendor`, `/account`, `/attachable`, **`/upload`**, `/journalentry`, `/invoice` … (**all writes**) | **Every `GET`** — including `/account`, `/bill`, `/vendor`, `/attachable`, **`/download`**, `/companyinfo`, `/preferences`, `/taxcode` |
| | **`/query` — both GET *and* POST** |
| | **`POST /batch`** · **`GET /cdc`** · **all reports** |

Not metered at all: Payments API, Payroll API, **all OAuth endpoints**, **all sandbox endpoints**. **Only successful (2xx) production calls are metered; errors are free.**

> ⚠ **Why this is the crux of Neoting's unit economics.** Coding a purchase invoice requires reading the chart of accounts, vendor list, tax codes and existing bills for dedupe; bank-matching requires reading transactions. **Every one is CorePlus.**
>
> **Sanity check: 500,000 CorePlus ÷ 300 client companies ≈ 1,660 metered calls per company per month ≈ 55/day.** A naive implementation that re-syncs each realm's account and vendor lists on a schedule will exhaust Builder quickly — **and Builder blocks rather than bills.**
>
> **Set against D48's £8.50 per client business per month, the economics are workable but not carelessly so.** Design implications, in priority order:
> 1. **Cache per realm aggressively** — chart of accounts, vendors and tax codes change rarely. Long TTLs, invalidate on webhook. *(`ReferenceSync` in the schema is exactly the right home for this.)*
> 2. **Webhooks, not polling.** CDC is metered; use it only to catch up after downtime.
> 3. **Never batch writes** — it converts free calls into metered ones.
> 4. **Design write-mostly.** Writes are free forever; reads are the entire cost centre.
> 5. **Plan Workspace topology deliberately** — usage, connections, tier and billing all aggregate per Workspace.

**Budget for a UK ISV:** **£0** through build and first pilots (Builder, 500k CorePlus/mo). **£225/mo Silver** ⏱ once you exceed 500k CorePlus *or* want a listing, plus overage above 1M at ~£2.60/1,000. ⚠ **Net 30 payment terms are Platinum + US-only — not available to a UK company.** Payment failure → ~27-day grace, then **all API access for the Workspace is blocked**.

#### 1.2.10 UK / AU regional specifics

**One app serves all regions — no separate registration per country.** The same client ID connects to UK, AU and US realms. But tax behaviour diverges and your code must branch on it.

| | UK | AU | US |
|---|---|---|---|
| `GlobalTaxCalculation` | **Required** | **Required** | Not applicable |
| Tax model | TaxCode / TaxRate / TaxAgency | same | Automated Sales Tax (different model) |
| Typical codes | `20.0% S`, `Exempt From VAT`, `0.0% Z` | `GST`, `GST Free`, `FRE` | jurisdiction-derived |
| Purchase-side tax | `PurchaseTaxRateList` on the TaxCode | same | n/a |
| Character encoding | **UTF-8** | UTF-8 | ISO-8859-1 |
| Program fee ⏱ | £225 Silver | not verified | $300 Silver |

Key mechanics: set `TaxCodeRef` **per line**; a `TaxCode` is a tax *group* referencing one or more `TaxRate`s split into `SalesTaxRateList` and **`PurchaseTaxRateList`** — for Bills you care about the purchase side. ⚠ **Sales tax cannot be enabled via the API** — check `Preferences.TaxPrefs.UsingSalesTax == true` first and fail gracefully if the client's file has VAT switched off. Override is possible but brittle (you must send **all** `TaxRateRef`s of a TaxCode even when changing one, and `ReadOnly` rates reject with error `6000`) — useful for reverse-charge and margin-scheme edge cases, and it should be **gated behind the human Approve**.

**UK MTD:** no MTD-specific API surface was found in the QBO developer docs. **Not verified** that any API path exists for MTD filing; assume Neoting posts transactions and QBO/the practice handles submission.

#### 1.2.11 Realistic timeline to first write into a real client ledger

| Phase | Elapsed |
|---|---|
| Developer account + app + **UK-region** sandbox | **Same day** |
| Build + test against UK sandbox | product-dependent |
| App Details for Production (EULA/privacy/ToS URLs **live**, support contact, hosting regions) | ~30 min of form-filling — **but days or weeks if the legal pages don't exist yet** ⚠ |
| Questionnaire submission → approval | **Not published — not verified.** Budget **1–3 weeks**; human-reviewed, and they may come back with questions |
| Production keys issued → **first write to a real client's ledger** | immediate |
| **Total, assuming the app is built** | **≈ 2–6 weeks** |
| *(Optional)* App Store listing + QBOA visibility | **+6–12 weeks** on top |

**Critical-path items that are not code** and should start now: the public website with compliant branding; **publicly accessible privacy policy, ToS and EULA** (note the EULA is a *fourth* document beyond `docs/legal/`'s three); **insurance** (professional indemnity + cyber + public liability, with a three-year tail — a contractual obligation from day one, not a listing-time ask); and a documented answer to the AI-subprocessor question.

**Sequencing recommendation:** **go live private on production keys with pilot practices** — no review, no tier fee, no listing. But **build Intuit SSO / OpenID Connect and multi-realm mapping from the start** even though it isn't needed privately, because it is the prerequisite for QBOA Apps-tab visibility and expensive to retrofit. Add Silver and the listing when ProAdvisor distribution becomes the growth channel — and **expect the annual third-party security review to arrive anyway once you pass 500 connections.**

**Open items to confirm directly with Intuit:** the literal question list in the App Assessment Questionnaire and its approval SLA; UK Gold/Platinum GBP rates; whether a KMS/HSM satisfies the "AES key in a separate configuration file" wording; how `POST /batch` meters its constituent operations; **whether Intuit treats an LLM API vendor as a prohibited "third party" for QuickBooks data**; UK availability of the QuickBooks Solution Provider programme; and any per-file attachment size cap.
### 1.3 Sage Business Cloud Accounting

> **Verdict: the easiest platform in this document by a wide margin, and the only Sage route that satisfies D43 properly. No certification gate before production, no cap on connected businesses, and Partner Edition maps almost perfectly onto the practice model.**

*Methodology note: `developer.sage.com` returns HTTP 403 to automated fetching (Cloudflare). Sage pages below were read via the Wayback Machine or a text proxy; the URLs cited are canonical.*

#### 1.3.1 Application path

| # | Step | URL |
|---|---|---|
| 1 | Create a free developer account (GitHub SSO or email) | [developer_signup](https://developer.sage.com/accounting/guides/getting-started/developer_signup/) |
| 2 | Register the app → `client_id` + `client_secret` | [client_app_registration](https://developer.sage.com/accounting/guides/getting-started/client_app_registration/) |
| 3 | Create a **30-day trial** Sage Accounting business per region (UK, IE, CA, US, ES, FR) | [FAQ](https://developer.sage.com/accounting/guides/concepts/faq/) |
| 4 | Submit the **upgrade form** → **Developer account = 12 months free.** Sage targets **3–5 working days** | [upgrade-your-account](https://developer.sage.com/accounting/quick-start/upgrade-your-account/) |
| 5 | Build. Ship. **You can go live here — no gate** | — |
| 6 | *(Optional, for Marketplace only)* Validation meeting → Marketplace T&Cs per region → listing | [journey](https://developer.sage.com/accounting/journey/) |

App registration asks for only four things — **App Name**, **Email Address**, **Homepage URL** (optional), and **Callback URLs** (at least one, up to **100**, HTTPS except localhost). **There is no company verification at registration.** You are a person with an email address until you decide to list.

#### 1.3.2 What Sage demands of the applicant company

**At signup: nothing.** You accept the [Developer Services Licence Agreement](https://developer.sage.com/assets/files/DeveloperServicesLicenseAgreement.pdf) (last updated **May 2025**) by clickthrough. Clause 2.1: *"We may approve or deny access to the Developer Services in our sole discretion"* — a reserved right, not an applied process.

For **Marketplace listing**, the [Marketplace Security Requirements](https://developer.sage.com/marketplace-security/) (last updated **23 February 2021**) are expectations, not a scored questionnaire:

| Demanded | Sage's framing |
|---|---|
| Public website + privacy policy | *"Partners should have a privacy policy which can be accessed from their website, along with clear terms and conditions regarding the data security"* |
| Cookies | Session cookies must set `Secure` and `HTTPOnly` |
| Vulnerability management | *"a program in place for scanning… on a regular basis"* |
| **Pen testing** | *"Regular independent testing of your security, such as pen testing"* — ⚠ **no frequency, standard or evidence format specified** |
| Test data | *"Never copying real data into test systems"* |
| Encryption | HTTPS/TLS in transit; **disk encryption wherever data is stored** |
| Access control | Least privilege; *"track and log all employees that have access to data"* |
| Incident response | Notify Sage *"without undue delay"* |

**Not required / not published — all "not verified":** company registration number, VAT registration, insurance minimums, named security contact, **data residency**. Sage requires GDPR/UK GDPR compliance and points at its [DPA](https://www.sage.com/en-gb/legal/terms-and-conditions/product-and-service-terms-and-conditions/data-processing-agreement/), but imposes **no UK/EEA hosting condition**.

#### 1.3.3 Certification / Marketplace listing

**Not required for production.** Required only to appear on the Sage Marketplace. Four published stages ([journey](https://developer.sage.com/accounting/journey/)): **Build** → **Validate** (an informal **recorded Microsoft Teams demo**) → **List** (accept Marketplace T&Cs **per region**; ⚠ **you must build a co-branded landing page on your own site** for the listing to point at) → **Succeed**.

What the validation reviews: *"Does the integration perform as advertised? Is the use of Sage branding correct? What data is being read/written…? How is that data secured…? **Where is the data hosted?** What is the customer experience like?"* — ⚠ **data hosting location is an explicit review question; pre-empt it.** **Duration and common failure reasons: not verified** — Sage publishes no SLA or rejection criteria.

#### 1.3.4 ⚠ Limits before certification

> **There is no documented cap on the number of connected businesses for an uncertified app.** Any Sage Accounting user can complete the OAuth flow against your registered `client_id` from day one. The only published ceilings are the app-wide rate limits in §1.3.7.
>
> *Caveat, stated honestly: this is an absence of evidence, verified across the Best Practices, FAQ, journey and DLA pages. Treat "no cap exists" as high-confidence but **not stated in the affirmative anywhere**.*

#### 1.3.5 Auth model

Source: [Authentication](https://developer.sage.com/accounting/guides/authenticating/authentication/)

| Item | Value |
|---|---|
| Flow | OAuth 2.0 **Authorization Code only**, PKCE supported |
| Authorize | `https://www.sageone.com/oauth2/auth/central?filter=apiv3.1` — always set `filter=apiv3.1` |
| API base | `https://api.accounting.sage.com/v3.1` |
| **Scopes** | ⚠ **Only two: `readonly` or `full_access`.** No granular scopes — **you must request `full_access` to write bills or attach files** |
| Auth code | Single use, **expires after 60 seconds** |
| **Access token** | ⚠ **300 seconds / 5 minutes** — the shortest in this document |
| **Refresh token** | **31 days**, and **rotates** on every use |
| Country routing | Three regional auth servers. Pass `country=gb` to skip the picker; a mismatch fails the request |

⚠ **The 5-minute access token plus 31-day rotating refresh is the operational risk. Build a refresh heartbeat, not lazy refresh-on-401.**

> ✅ **Sage Partner Edition is the practice model, and it collapses the multi-tenancy problem.** *"When Partner Edition users authorise 3rd party applications and integrations, the API is able to access **all of the businesses the authenticated user is able to view** under the Active tab in the UI."* ([Partner Edition](https://developer.sage.com/accounting/guides/concepts/partner_edition/))
>
> **One OAuth grant from one practice = write access to every client business that practice manages.** `GET /businesses` enumerates them; the **`X-Business`** header targets them. Since **July 2025** that endpoint supports `active_only`, `name` and `product_family` filters plus pagination (max 500 per page).
>
> **This is the single best multi-tenancy story of any platform here — better than Xero, where Bulk Connections is gated behind the A$1,445/mo Advanced tier.** For a practice with 200 clients, Sage needs one consent journey and Xero needs 200.

Two operational traps:
- ⚠ **Always send `X-Business` explicitly in production.** Omitting it silently targets the "lead business", which **can change** if the user's first business is deleted or they create a new one. Compare the `X-Business` *response* header to detect drift ([best_practices](https://developer.sage.com/accounting/guides/concepts/best_practices/)).
- **The API inherits the authorising user's access rights.** A restricted user gets `403 MultiUserAccessDenied` on POST. *"When your client receives a 403 response on each and every request, it should discard the access and refresh token and request a new authorization"* ([access_rights](https://developer.sage.com/accounting/guides/concepts/access_rights/)).

#### 1.3.6 The API surface

**`POST /purchase_invoices`** — required: `contact_id`, `date`, `due_date`, `invoice_lines`. Per line: `description`, **`ledger_account_id`** (nominal), `quantity`, `unit_price`, **`tax_rate_id`**, and ⚠ **`tax_amount` is required in v3.1** unless the rate is `zero`, `exempt` or `no_tax`. Header supports `vat_reverse_charge` (UK DRC), `postponed_accounting`, and CIS fields. **`POST /other_payments`** is the card-receipt path ("Money Out").

> ⚠ **Sage Accounting Start cannot take purchase invoices.** `/purchase_invoices`, `/purchase_credit_notes` and `/purchase_quick_entries` are **Accounting-only, not available on Start** ([differences](https://developer.sage.com/accounting/guides/concepts/differences_between_Accounting_and_Start/)). **Any practice client on Start must be routed to `/other_payments` instead. Detect the tier before choosing the posting shape.** *(This is the third platform where the cheap SKU is where the API gets thin — cf. Xero ledger/cashbook and MYOB Connected Ledger. It is a pattern, and the posting engine should be built to expect it.)*

##### ✅ D43 — attaching the source document: YES

```
POST /attachments
{ "attachment": {
    "file": "<base64>", "file_name": "invoice-1423.pdf",
    "mime_type": "application/pdf", "file_extension": ".pdf",
    "attachment_context_id":      "<origin_id of the purchase invoice>",
    "attachment_context_type_id": "PURCHASE_INVOICE" }}
```

| | |
|---|---|
| Allowed types | **PDF, GIF, JPEG, JPG, PNG, TIF, TIFF** — ✅ **the only platform here that accepts TIFF** |
| Encoding | **base64 in the `file` field** (JSON, not multipart) |
| **Max file size** | ⚠ **not verified** — the attachments swagger is not publicly archived and Sage publishes no limit. **Test empirically** |
| Contexts | `PURCHASE_INVOICE`, `PURCHASE_CREDIT_NOTE`, `OTHER_PAYMENT`, `JOURNAL`, `BANK_TRANSFER`, `SALES_INVOICE`, … |

⚠ Two gotchas: the attachment must be created **after** the invoice (you need its **`origin_id`, not its `transaction_id`**), and **the worked example in Sage's own guide has `attachment_context_id` and `attachment_context_type_id` transposed** — trust the field semantics, not the sample.

> ✅ **Note this directly contradicts the competitor benchmark in §1.13.** Dext falls back to a link on Sage Accounting because *"Quick Entries don't support file attachments"* — but AutoEntry posts a real attachment, and the API above shows why: **the limitation is the Quick Entry entity, not Sage Accounting.** Post a `purchase_invoice`, not a `purchase_quick_entry`, and D43 is fully satisfied where Dext's is not. **That is a genuine, defensible product differentiator.**

**✅ Idempotency: yes, opt-in — the best support of any platform here.** Pass a **32-character hyphenless GUID** as `idempotency_id` inside the entity namespace. Window is **7 days** (vs Xero's 6 minutes). Supported on `purchase_invoice`, `purchase_credit_note`, `purchase_quick_entry`, `other_payment`, `contact`, `journal`, `ledger_account`. ⚠ **`attachment` is NOT in the supported list** — guard the attachment POST with your own dedupe ([Idempotency](https://developer.sage.com/accounting/guides/concepts/idempotency/)).

> 💷 **Money is a decimal — flag every boundary.** The swagger types **every** monetary field as `"type": "number", "format": "double"` — IEEE-754. That covers `net_amount`, `tax_amount`, `total_amount`, `unit_price`, `quantity`, `exchange_rate` and every `base_currency_*` variant. ⚠ **GET responses in the docs sometimes render them as quoted strings (`"total": "10.0"`), so you must handle both a JSON number and a JSON string on the way back.**

⚠ **Concurrency:** *"Avoid making parallel POST requests to… `purchase_invoices`, `purchase_credit_notes`, `contacts`, `products`…"* — **serialise posts per business.**

#### 1.3.7 Rate limits

- **1,296,000 requests per app per day** (≈15/sec sustained)
- ⚠ **Maximum 150 concurrent requests at any time, per app**
- **No per-business limit is published**

> ⚠ **Both are per app, not per business.** With hundreds of client businesses behind one `client_id` these are **shared**. 1.3M/day is generous, but **150 concurrent is the real constraint on a fan-out sync** — and it is the inverse of FreeAgent, where the budget is per client. Design the worker accordingly.

Pagination caps at **200 items per page**. Cache the ~26 static reference endpoints. Log the `x_request_id` response header; Sage support asks for it.

#### 1.3.8 Sandbox / test access

> ⚠ **There is no sandbox.** Verbatim from the [FAQ](https://developer.sage.com/accounting/guides/concepts/faq/): *"At present there is no demo/sandbox environment for development purposes. Trial accounts need to be created for each of the regions your app integrates with and will expire after 30 days."*

The workaround is the **Developer account**: create a trial, submit the upgrade form, get **12 months free** on a real Accounting business, per region. **Practical consequence: you are always testing against production infrastructure on a real business.**

#### 1.3.9 Costs and timeline

**Developer account free. API access free today** — but DLA clause 10.1 reserves the right to charge: *"We reserve the right at any time to charge fees for access to, and use of, the Developer Services."* **Marketplace listing fee and revenue share: not verified** (the Marketplace lists "Resale and Referral ISV Partner applications", so commercial terms exist but none are published).

| Phase | Elapsed |
|---|---|
| Signup + app registration + first OAuth round-trip | **1 day** |
| Trial → Developer account upgrade | **+3–5 working days** (Sage's own target) |
| Purchase invoice + attachment + idempotency end-to-end | **+2–3 weeks** |
| Partner Edition multi-business, token refresh fleet, 403 handling, Start-tier fallback | **+3–5 weeks** |
| **Writing into a real client ledger** | **≈6–8 weeks from a standing start** |
| Marketplace validation + listing (optional, parallel) | **+4–12 weeks, not verified** |

### 1.4 Sage 50 (UK)

> **⚠ Verdict: this is not an API integration. It is a Windows desktop agent product behind a ~£2,500/yr licence gate, and D43 cannot be satisfied — you cannot attach a file to a transaction programmatically. Treat Sage 50 as a migration on-ramp to Sage Accounting, not an integration target.**

#### 1.4.1 Is there a cloud API? No.

The authoritative statement, from a Sage moderator, 2 December 2022:

> *"At present there is no supported API available for Sage 50c UK. For the UK version of Sage 50c the only means of currently writing data is via the SDK, known as Sage Data Objects."*
> — [developer-community.sage.com/topic/495](https://developer-community.sage.com/topic/495-api-for-sage-50/)

Corroborated three ways: Sage's KB ["An overview of the Sage Developers programme"](https://gb-kb.sage.com/portal/app/portlets/results/viewsolution.jsp?solutionid=200427112331075) (last modified 17 Oct 2025) lists REST APIs for **Sage Business Cloud Accounting, Sage 200 Standard Online, Sage 200 Professional and Sage CRM only** — Sage 50 appears solely under "SDK"; the live developer.sage.com catalogue contains **no Sage 50 of any region**; and the Sage 50 v34 release notes (June 2026) announce no API.

| Route | Read | Write | Supported? |
|---|---|---|---|
| **SDO (Sage Data Objects)** | Yes | **Yes** | Yes, under paid programme |
| ODBC driver | Yes | **No — read-only** | **No.** *"unsupported and fields are liable to change"* |
| SData | — | — | **No.** *"unsupported by Sage"* |
| File Import (CSV/XLS) | — | Partial | Yes, but **GUI-only end-user feature** |

#### 1.4.2 ⚠ The classic trap: UK vs North America

| | **Sage 50 Accounts (UK & Ireland)** | **Sage 50 Accounting (US / Canada)** |
|---|---|---|
| Lineage | Sage Sterling → Line 50 → Sage 50 Accounts | **Peachtree** (US) / **Simply Accounting** (CA) |
| SDK | **SDO** — ActiveX/COM, version-pinned (`SageDataObject260`…) | **`Interop.PeachwServer.dll`** — COM + .NET |
| SDK availability | **Paid, gated behind the UK Sage Developer Programme** | **Publicly downloadable** |
| REST API | **None** | **None** |

**They are different products with the same name.** Sage's own AutoEntry documentation states it flatly: **"The SDO is only for Sage 50 UK&I companies."** Sage's *Accountant Link* was **removed in v29**.

#### 1.4.3 SDO — what it is, how it is licensed, what it costs

*"Sage Data Objects (SDO) is a collection of ActiveX dynamic link libraries… an object-based interface with methods and properties… Supported for use in C# .NET and Visual Basic .NET"* ([Development Basics](https://gb-kb.sage.com/portal/app/portlets/results/viewsolution.jsp?solutionid=200518071050312)). ⚠ **The type library is pinned to the Sage 50 release, so every major version means a rebuild.**

**Two separate things, and only one is paid:**
- The **SDO runtime redistributable is free and public** — per-version `Sage50Accounts_SDO.msi` installers.
- ⚠ **The SDK — help files, full object reference, and the right to build against it — is paid and gated.** Sage: *"Only members of the UK Sage Developer Programme have access to the developer tools for Sage 50 Accounts."* A Sage employee: **"SDO is not free to consume. It is a licensed component and usage of it requires a subscription."**

| Item | Amount | Confidence |
|---|---|---|
| **Sage 50c SDK tier** | **£2,500 + VAT / year** | Posted by Sage 18 Sep 2023 |
| Sage 200c tier (includes 50c SDK) | £3,996 + VAT / year | Same source |
| ⚠ **Price increase effective 01 Aug 2025** | Sage's KB **redacts the new figure** as `<value> per month/year (exc VAT)` | [ie-kb.sage.com](https://ie-kb.sage.com/portal/app/portlets/results/view2.jsp?k2dockey=250725123504990) |

> **The current 2026 fee is "not verified" — Sage deliberately did not publish it. Budget £2,500–£4,000 + VAT/yr and treat it as a sales-call question.**

The subscription includes SDK access, test product copies, developer support, Authorised Developer status, **Qualified Status with Sage Marketplace listing**, and External Integration Testing at a "Sage preferred rate".

#### 1.4.4 Sage Data Service / Remote Data Access — not a remote API

RDA (formerly Sage Drive) is a **data-sync service, not a remote API**. It replicates the dataset to Sage's cloud and back to each machine; everyone still runs full Sage 50 locally against a **local copy**. **There is no network endpoint — SDO connects to a file path, always.**

⚠ Directly relevant ceiling: **the Transaction Attachments folder should stay under 1000 MB**, because attachments *are* synced and bloat RDA.

> ⚠ **One thing worth chasing before committing money.** Sage 50 v31.1+ user management now offers a login type labelled **"Use third-party applications"**, with the note *"This option only appears if you have Sage Copilot enabled"* ([KB](https://gb-kb.sage.com/portal/app/portlets/results/view2.jsp?k2dockey=250916114508543)). Combined with v32's "Manage cloud connection" plumbing, **this suggests Sage is building a cloud third-party path for Sage 50 that is not SDO. Nothing about it is publicly documented.** Ask `isvdeveloperuk@sage.com` — **if a Sage 50 cloud path is 12 months out, a COM agent has a short half-life and the £2,500 is badly spent.**

#### 1.4.5 What third parties actually do

**Every serious player ships a Windows on-prem agent driving SDO. Not CSV, not an API.**

| Product | Agent | Where it must live |
|---|---|---|
| **Dext** | Dext Connect App | *"must be installed on the same computer or server where the Sage 50 company file is stored, and must remain online"*; *"Each company file you connect must have its own dedicated user"* |
| **AutoEntry** (Sage-owned) | AutoEntry Sync App | On the computer holding the accounts data |
| **Codat** *(third party)* | On-prem connector | Windows only, **single-tenant, not hosted, not macOS**; three most recent Sage versions only |

Dext's constraints, which you would inherit: Sage 50 UK **v2022.3+**; a **dedicated Sage 50 user** per company; **Cost Codes do not sync; Bank Match is not supported; Share Mode is not supported.**

**File Import (CSV/XLS)** is the unlicensed fallback and a bootstrap tool, not a product: ⚠ **fields truncate silently with no error raised**, double-quote characters cannot be imported at all, the Invoices & Credits module and Purchase/Sales Orders cannot be imported, no attachments, no idempotency, no returned transaction numbers, and it is **manual GUI operation**.

#### 1.4.6 ❌ D43 — attaching the source document: NO

The feature exists but is **GUI-only** — allowed types BMP, CSV, DOCX, JPG, PDF, PNG…, **max 5 MB per attachment**, and the method is *Suppliers → Batch invoice → Attach column → '+' icon → drag-and-drop* — **a human clicking in a Windows dialog**.

> **The proof it isn't writable: AutoEntry is owned by Sage, has unrestricted SDO access, and still cannot post the file.**
>
> > **"When you publish a document from AutoEntry to Sage 50 Accounts, AutoEntry doesn't post the PDF file. Instead, there's a link that re-directs you back to the AutoEntry website to view the Invoice."**
> > — [help.autoentry.com](https://help.autoentry.com/en/articles/5227772-how-to-view-invoice-images-in-sage-50-uk-i)

No public SDO attachment object exists. Whether the paid SDO help file documents one is **not verified** — but if it did, AutoEntry would use it.

**The workaround you must build, and it is the four-rung ladder again:**
1. Store the immutable source document in **your own** object store, keyed by content hash. **That is your real D43 system of record.**
2. Post a durable signed HTTPS URL onto the transaction using the same link mechanism AutoEntry uses. *The exact SDO field is not publicly documented — **not verified***.
3. **Belt and braces:** write your document code into `EX_REF` / `EXTRA_REF` (updatable via `internal_ref`). AutoEntry does exactly this.
4. ⚠ **Do not write PDFs directly into the Transaction Attachments folder.** You would also have to write the DB link record — undocumented, breaks on upgrade, and explicitly excluded from Sage support as *"Bypassing business logic for direct data/SQL manipulation"*.

> **Be explicit with clients in writing:** on Sage 50, **D43 is satisfied by a permanent link plus a reference field, not by a file embedded in their Sage data.** This is precisely the honesty D43 already demands — *"whichever rung is live is stated to the accountant"*.

#### 1.4.7 Application path, company requirements, certification, limits

**No self-service signup exists.** The mandatory gate is **emailing `isvdeveloperuk@sage.com`** to join the UK Sage Developers Programme (parallel contacts `ukisvhelp@sage.com`, `developers.programme@sage.com`), then a tier and pricing discussion, signing the DLA and Acceptable Use Policy, paying the annual subscription, and downloading the SDK from [my.sage.co.uk/downloadcentre](https://my.sage.co.uk/downloadcentre/). Whether a separate NDA is required: **not verified.**

**Company requirements: not verified / not published.** The only published document is the Sage *Business Cloud* Marketplace security page, so **whether it even applies to a Sage 50 desktop integration is not verified.**

**Certification is NOT required for production — and structurally cannot be enforced.** SDO is a local COM library; there is no Sage-hosted endpoint. Once you hold a subscription and ship an agent, it connects to whatever data path and Sage username the customer gives you. **Sage cannot revoke it per-tenant.** Listing is what certification buys — plus **External Integration Testing, which Sage charges for at a rate that is not verified.**

**⚠ Limits before certification: no published cap, and structurally none can exist.** SDO has no app registration, no client ID, no API key and no server-side connection counter. **Sage has no visibility into how many companies you touch.** The real limits are your licence terms and physics: one Windows agent per data location, one Sage user session per concurrent connection.

#### 1.4.8 Auth model — there is none, in the modern sense

```csharp
oWS.Connect(szDataPath, username, password, "AppName");
```

Four arguments: **data path, Sage 50 username, Sage 50 password, application name.** **No OAuth, no tokens, no expiry, no scopes, no refresh.**

> ⚠ **What you inherit is the worst credential story in this document.** You must hold, at rest, a **Sage 50 username and password per client company**, in a form you can pass to a COM call. It is a **permanent shared secret with no rotation mechanism and no scope limitation** — strictly worse than MYOB's cftoken, which at least sits alongside OAuth. For a product whose security posture is a selling point to practices, this is a material liability, and it should be weighed against the £2,500 before anything else.

**The scaling problem for a practice:** if the practice hosts all client datasets on one server, one agent serves all. **If each client hosts their own Sage 50 on their own premises — the common case — you need one agent installed per client site, each staying online.**

#### 1.4.9 SDK surface, money, idempotency, concurrency

> 💷 ⚠ **Money is IEEE-754 `Double` everywhere**, from Sage's own sample code — `UNIT_PRICE`, `NET_AMOUNT`, `FULL_NET_AMOUNT`, `TAX_RATE` and **even quantities** are all `(Double)`. Convert pence → decimal at the edge only, never round-trip.
>
> ⚠⚠ **VAT is silently recalculated unless you say otherwise.** Sage's own inline comment: *"the update method now wraps internal business logic that calculates the VAT amount if a net amount is given. **If you wish to calculate your own Tax values you will need to ensure that you set the `TAX_FLAG` to 1 and set the `TAX_AMOUNT` value on the item line.**"*
>
> **You must set `TAX_FLAG = 1` and supply `TAX_AMOUNT` explicitly, or your posted VAT will differ from the supplier invoice.** This is a first-order correctness hazard for a document-to-bookkeeping product. Also: **`GLOBAL_NOM_CODE` on the header overrides every line's nominal code** — leave it blank when posting per-line coding.

**Idempotency: none.** `Update()` returns a boolean with no structured error — Dext documents Sage returning the useless generic *"Invalid value specified"*.

⚠ **SDO bypasses Sage 50 lock dates.** Dext lists *"Lock dates set in Sage 50 are being ignored"* under unexpected behaviour. **For a practice product with an Approve gate, you must enforce period locking yourself.**

**Concurrency and locking:** one session per Sage username (*"this username is already in use"*), so N concurrent connections = N Sage user accounts — **and Sage 50 licences are priced per user**. Exclusive mode (year end, data repair) blocks all SDO logins. ⚠ **Bulk posting can crash Sage** — v32.0's bug-fix list includes *"Sage50 crashing in the data service while creating large amounts of data using SDO"*.

#### 1.4.10 Costs and timeline

| Item | Amount |
|---|---|
| **Developer Programme, Sage 50c SDK tier** | **£2,500 + VAT / yr** (2023 published; increased 1 Aug 2025, figure unpublished) |
| External Integration Testing (certification) | Charged, rate **not verified** |
| Marketplace listing fee / revenue share | **not verified** |
| SDO runtime redistributable | £0 |
| Extra Sage 50 *users* (one per concurrent session) | Per-user licence cost |

**Hidden costs:** a rebuild every Sage 50 major release (annual); a full Windows agent programme (installer, silent auto-update, service lifecycle, tray UI, AV/firewall allow-listing, remote diagnostics); and a support load dominated by the customer's environment.

| Phase | Elapsed |
|---|---|
| Commercial engagement with Sage (email, quote, procurement, DLA, payment) | **2–6 weeks** |
| SDK access, first SDO connection to demo data | +1 week |
| Purchase-invoice posting spike incl. `TAX_FLAG` correctness | +2–4 weeks |
| **On-prem Windows agent — the real work** | **+8–16 weeks** |
| Multi-tenant control plane, document-link hosting, reconciliation | +4–8 weeks |
| Pilot with one friendly practice | +4–8 weeks |
| **Writing into a real client ledger at shippable reliability** | **≈5–9 months** |

#### 1.4.11 ⚠ Two facts that should change the decision

**A. Sage already ships your product inside Sage 50.** "AI Document Capture" (ex-"Purchase Automation") is native since v31: *"uploads supplier invoices and credit notes… scans and processes the relevant transactions automatically… **No add-on apps to pay for — It's built right into your software**"*. Included credits: Essentials 25/mo, Standard 50, Professional 75; overage **£0.20 per credit**. **Sage for Accountants** bundles **100 Purchase Automation documents free, then £0.20 each** ([pricing](https://www.sage.com/en-gb/accountants/pricing/)).

> **That is the competitive price point for capture-and-post, set by the vendor who owns the ledger. £0.20/document against Neoting's £8.50/client/month is a comparison a practice will make.** The answer is that Neoting is not selling capture — it is selling the chase, the dedupe, the bank match, the Approve gate and D43 traceability. **But the answer has to be ready.**

**B. The migration escape hatch.** Sage runs a first-party Sage 50 → Sage Accounting migration: source on v16+, **2 years of history**, dedicated Migration Specialist, **target 3 working days per dataset**, client retains a read-only Sage 50 licence. **This is the only Sage 50 path that ends with D43 actually satisfied** — and helping a practice migrate its clients to Sage Accounting may be a better use of effort than building a COM agent.

### 1.5 FreeAgent

> **Verdict: the cleanest developer experience in this document, a real self-serve sandbox, a purpose-built Practice API that is exactly the right shape, and unambiguous file attachment. The catches are a hard 5 MB / restricted-MIME limit, `application/x-pdf` (not `application/pdf`), no idempotency, no scopes, and a 40-line cap per bill.**

#### 1.5.1 Application path

**Track A — companies (self-serve):** sign up at [dev.freeagent.com/signup](https://dev.freeagent.com/signup) → create an app in the [Developer Dashboard](https://dev.freeagent.com/apps) → create a sandbox company at [signup.sandbox.freeagent.com](https://signup.sandbox.freeagent.com/signup) → build → **go live by changing the hostname**: *"To use the production API (instead of the sandbox one) change the two endpoints to reference `api.freeagent.com`."*

**Track B — the Practice API (this is the one you want):**

| # | Step |
|---|---|
| 1 | **Email `integrationsrequests@freeagent.com`** for *"a free temporary FreeAgent Practice Dashboard account on our sandbox"* |
| 2 | Set up the sandbox practice, create a test client |
| 3 | Create an app in the Developer Dashboard, **ticking "Enable Accountancy Practice API"** |
| 4 | *"your account managers will be able to authorise the application using OAuth and make requests to the Practice API to access data and perform actions on behalf of their clients"* |

Source: [accountancy_practice_api](https://dev.freeagent.com/docs/accountancy_practice_api). **Step 1 is the only human gate in the whole FreeAgent process, and it is for a sandbox account, not for production access.**

#### 1.5.2 What FreeAgent demands of the applicant company

**Notably little.** The [API Terms](https://dev.freeagent.com/docs/api_terms) impose **security obligations, not corporate ones**: OAuth 2.0; keep credentials secure; ⚠ **breach notification to `security@freeagent.com` within 72 hours**; least-privilege access; anti-virus on endpoints; data minimisation (must not *"collect or persistently store any FreeAgent account details"* without consent); and branding that does not cause confusion.

**Not required — absent from the published terms:** registered company details, VAT registration, security questionnaire, **pen-test evidence**, insurance minimums, named security contacts, **data residency**. FreeAgent may terminate immediately for breach or if *"we reasonably believe that your continued use of the API creates material risk for us"*; otherwise **90 days' notice**.

#### 1.5.3 Certification and gallery listing

**No certification is required for production.** Going live is a one-line endpoint swap. Listing in the [integrations gallery](https://www.freeagent.com/integrations/) is separate and marketing-led — *"Want to join our list of partner integrations? Email `integrationsrequests@freeagent.com`"*. Categories include **"Data entry and expenses"** and **"Practice management"** — Neoting's natural homes. **Review criteria, duration and failure reasons: not verified.**

#### 1.5.4 ⚠ Limits before approval — checking the historical restriction

> **Finding: no such restriction is documented today.** Checked across three sources — [quick_start](https://dev.freeagent.com/docs/quick_start) (going live is a URL change; **no approval step, no company-count cap**), [API Terms](https://dev.freeagent.com/docs/api_terms) (**no pre-approval requirement and no cap on connected companies**), and [oauth](https://dev.freeagent.com/docs/oauth) (*"One access token will be issued for each FreeAgent user which has authorised your application"*, with no gating language).
>
> The only throttle FreeAgent describes is **behavioural, not numeric**: *"We will be reviewing apps which continue to make a high volume of requests to our API while rate limited, and may have to take action to further restrict apps which do not respect the limits."*
>
> ⚠ **Caveat, stated plainly:** the premise that FreeAgent historically restricted unapproved apps to the developer's own account is **not verified either way**. No current documentation asserts it and none rescinds it. **Because this is load-bearing for the multi-tenant plan, confirm it in writing with `integrationsrequests@freeagent.com` before building against the assumption. A one-line email answer is cheap insurance.**

#### 1.5.5 Auth model

| Item | Value |
|---|---|
| Flow | **OAuth 2.0 Draft 22**, authorization code |
| Authorize / Token | `https://api.freeagent.com/v2/approve_app` · `/v2/token_endpoint` |
| Sandbox | `https://api.sandbox.freeagent.com/…` |
| **Scopes** | ⚠ **None. FreeAgent has no scope system** — a grant is all-or-nothing |
| **Access token** | **1 hour** |
| **Refresh token** | ✅ **≈20 years** (`refresh_token_expires_in: 631151957`) — by far the longest here |
| Rotation | **Yes** — a refresh returns new access *and* refresh tokens |

> ⚠ **The absence of scopes is a governance point for a practice product.** You cannot tell a practice "we only have write access to bills" — **the grant covers payroll, self-assessment returns, VAT returns and corporation tax returns too.** Expect that question in a security review and have an internal least-privilege answer ready, because the platform will not provide one.
>
> ✅ **Conversely, the ~20-year refresh token removes the single biggest operational hazard on every other platform** — no keep-alive job, no silent expiry over a quiet period.

> ✅ **The Practice API is the multi-tenancy answer, and it is excellent.** **One OAuth grant per account manager**, not per client company. Target a client with the **`X-Subdomain:`** header. *"All the standard FreeAgent API endpoints can be accessed in this way."* Practice endpoints: `GET /v2/clients`, `/v2/account_managers`, `/v2/practice`.
>
> ⚠ **Senior account managers see all clients; others see only their own** — **authorise a senior AM, or you will silently miss clients.** `minimal_data=true` raises pagination from 100 to 500 per page.

#### 1.5.6 The API surface

**`POST /v2/bills`** ([bills](https://dev.freeagent.com/docs/bills)) — required: **`contact`** (URI), **`reference`**, **`dated_on`**, **`due_on`**. ⚠ **`bill_items[]` is capped at 40 items per bill** — a long itemised invoice must be split, and the splitting rule needs deciding deliberately (cf. the same class of problem as VT's one-nominal-per-row). Per item: **`category`** (URI = your ledger account) and **`total_value`** (**including** taxes).

**Ledger accounts:** `GET /v2/categories` returns `admin_expenses_categories`, `cost_of_sales_categories`, `income_categories`, `general_categories`, each with `url`, `description` and **`nominal_code`**. ⚠ **Map your chart to `nominal_code` but post the `url`.**

**Bank matching:** `POST /v2/bank_transaction_explanations` — set **`paid_bill`** to settle a bill (*"A link to the Bill that was paid or refunded"*), and **no category is required** in that case. ✅ **Explanations accept their own attachment object**, so a receipt can hang off the bank side too.

##### ✅ D43 — attaching the source document: YES, and it is the simplest of all

The attachment is a **sub-object on the create call**, not a separate upload — **one API call instead of two**:

```json
"attachment": {
  "data": "<base64 of the file>",
  "file_name": "invoice-1423.pdf",
  "content_type": "application/x-pdf"
}
```

| | |
|---|---|
| **Max file size** | ⚠ **5 MB** |
| **Allowed content types** | `image/png`, `image/x-png`, `image/jpeg`, `image/jpg`, `image/gif`, **`application/x-pdf`** |
| Supported on | `bills`, `expenses`, `bank_transaction_explanations` |
| Read back | `GET /v2/attachments/:id` returns `url`, `content_src`, **`expires_at`**, `content_type`, `file_name`, `file_size` |

**Three traps worth writing down:**
1. ⚠ **It is `application/x-pdf`, not `application/pdf`.** **Standard MIME detection libraries will hand you the wrong string and FreeAgent will reject it.** Map explicitly.
2. ⚠ **No TIFF, no HEIC, no WebP.** Phone-camera HEIC and scanner TIFF must be transcoded to JPEG or PNG. *(Same transcoding requirement as MYOB and Zoho — this is now a shared pipeline component, not a per-platform quirk.)*
3. ⚠ **`content_src` URLs carry an `expires_at`.** Never persist them as your permanent D43 pointer.

**Idempotency: none.** No mechanism is documented anywhere. Dedupe on the bill `reference` combined with `contact`, or your own code in `reference` / `receipt_reference`, and search on read-back before posting.

> 💷 ✅ **Money is a decimal *string* — and this is the good news of the whole document.** FreeAgent serialises monetary values as **JSON strings**, not numbers: `"total_value": "100.0"`, `"gross_value": "-20.0"`. **This is the only platform here that does not put money through a float on the wire, which eliminates an entire class of conversion risk.**
>
> ⚠ One caveat: the trailing form is `"100.0"`, **not `"100.00"` — do not string-compare.** Parse into a decimal type at the edge; emit from integer pence via a single formatter. `file_size` on attachments is genuinely an Integer — the only one.

⚠ **Account locks** ([account_locks](https://dev.freeagent.com/docs/account_locks)) exist with `locked_to_date` and year-end system locks, but **how the API behaves when a period is locked, and what error it returns, is not documented — not verified.** For a practice product this matters: **test posting into a locked period and handle whatever comes back.**

#### 1.5.7 Rate limits — the best structure of any platform here

From [introduction](https://dev.freeagent.com/docs/introduction), verbatim: **120 user requests per minute**, **3,600 user requests per hour**, **15 token refreshes per minute**, **scoped to individual users** — and:

> ⚠ ✅ **"For practice API users, limits apply to individual clients (by sub-domain included in the headers)."**

> **That single line is the best architectural fact in this document. On the Practice API the 120/min and 3,600/hr budgets are per client company, not shared across the practice.** A practice with 300 clients gets 300 independent budgets. **Contrast with Sage, where 1,296,000/day and 150 concurrent are shared across every business behind one `client_id`.**

⚠ The **15 refreshes/minute** cap is a real constraint if you refresh lazily across many grants — use a single coordinated refresh per grant. *(Figures read live 3 September 2026; they have changed historically — re-check before finalising capacity planning.)*

#### 1.5.8 Sandbox, costs, timeline

> ✅ **A real, free, self-serve sandbox — the only one of the UK platforms with one.** API host `api.sandbox.freeagent.com`; company signup at [signup.sandbox.freeagent.com](https://signup.sandbox.freeagent.com/signup); **sandbox practice dashboard by emailing `integrationsrequests@freeagent.com`**. **Promotion to production is a hostname swap only.** ⚠ **Whether sandbox data resets, and on what schedule ("temporary" implies it does): not verified.**

**Costs:** developer account, app registration, sandbox and **API access are all free**, with **no fee documented anywhere** in the API terms or developer docs — including for the Practice API. **Gallery listing fee and revenue share: not verified.**

**Practice-side commercials, which tell you your customers' economics** ([Partner Programme](https://www.freeagent.com/accountants/partner-programme/)): five tiers by active client licences — Partner (1), Bronze (10), Silver (35), Gold (75), Platinum (300) — with discounts rising by volume. ⚠ **Clients banking with NatWest, RBS, Ulster Bank or Mettle get FreeAgent free** — which is why FreeAgent penetration in UK micro-business is **higher than its paid market share suggests**, and why a practice-facing product should not skip it.

| Phase | Elapsed |
|---|---|
| Developer signup, app registration, sandbox company, first OAuth round-trip | **1 day** |
| Email for a sandbox Practice Dashboard | +2–10 days (turnaround **not verified**) |
| `POST /v2/bills` with attachment + category mapping + `X-Subdomain` targeting | +2 weeks |
| Own dedupe layer, MIME transcoding (HEIC/TIFF → JPEG, `application/x-pdf`), 5 MB compression, 40-line splitting, refresh fleet | +2–4 weeks |
| Bank matching via `bank_transaction_explanations` / `paid_bill` | +1–2 weeks |
| **Writing into a real client ledger** | ✅ **≈4–7 weeks from a standing start — the fastest of all platforms here** |
### 1.6 MYOB Business

> **Naming first, because it is genuinely confusing.** There is now **one** SME API. What was the *AccountRight Live API* has been renamed the **MYOB Business API**, and it serves **both** MYOB Business (ex-Essentials) files **and** AccountRight files. Every `developer.myob.com/api/accountright/*` URL 301-redirects to `/api/myob-business-api/*` (verified 3 Sep 2026). The base URL is still `https://api.myob.com/accountright`. The old *MYOB Essentials API* is legacy. API **v1 was decommissioned 9 April 2020**. Use `x-myobapi-version: v2`.
>
> §1.6 covers programme, auth, entities and limits — **identical for both products**. §1.7 covers only what is genuinely different about AccountRight.

#### 1.6.1 Application path, step by step

| # | Step | Where | Notes |
|---|---|---|---|
| 1 | Choose a membership tier | [developer.myob.com/what-is-the-developer-program](https://developer.myob.com/what-is-the-developer-program/) | ⚠ **The programme is paid and monthly.** See §1.6.9 |
| 2 | Submit "Get API access now" | [apisupport.myob.com ticket form 360000039035](https://apisupport.myob.com/hc/en-us/requests/new?ticket_form_id=360000039035) | Manual review by MYOB's Customisation & Integration team |
| 3 | MYOB creates your developer account | Welcome email with a **developer client ID** | [Getting started](https://apisupport.myob.com/hc/en-us/articles/6908884026895-Getting-started) |
| 4 | my.myob.com.au → Developer tab → **Register App** | my.MYOB | App Name (shown on the consent screen), Redirect URL (**must be `https://`**), Website, Description |
| 5 | API key + secret issued **immediately** | my.MYOB | *"Key registration is nigh-on-instant"* |
| 6 | Request a shared sandbox invite | Support ticket | §1.6.8 |
| 7 | Get invited to each real client company file | Per client, by the client | §1.6.5 |

**There is an approval gate — but it is on the *account*, not the key.** Once the developer account exists, keys are self-service and instant. Turnaround: *"If you register Mon-Fri before midday, chances are you'll have your account setup that same day, we're pretty good at turning them around in sub 60mins."* Team hours are Mon–Fri 9am–5pm **NZT** ([source](https://apisupport.myob.com/hc/en-us/articles/360000479736-How-long-does-registration-for-a-Developer-Account-take)).

⚠ **Key cap:** *"By default, all accounts are entitled to 2 API Keys, any future keys will need to be manually activated by MYOB API support… Even if you delete the original keys, new keys will always require manual activation."* You must supply "the expected use case" ([article](https://apisupport.myob.com/hc/en-us/articles/360000490416-Why-are-my-API-Keys-inactive)). Two keys covers dev + prod; a per-environment-per-region key strategy needs tickets.

#### 1.6.2 What MYOB demands of the applicant company

From the [Developer Program and Platform Terms and Conditions](https://developer.myob.com/program/terms-conditions/business-api-tandcs/) (**Last Updated 12 March 2026**), clause 1 — eligibility:

> "To be eligible for the Program, you must: … c. identify which MYOB APIs you require access to and describe a use case…; **d. describe the services you provide and a link to at least one case study based on a MYOB integration**; and e. agree to adhere to MYOB Developer Security Requirements and the MYOB Partner Brand Guidelines."

> ⚠ **Clause 1(d) is a chicken-and-egg trap for a new entrant.** It asks for a case study *based on a MYOB integration* before you have one. **Expect to negotiate this** — substitute a UK Xero/QBO case study plus a named AU design partner. Clause 3: *"MYOB reserves the right to accept or decline any organisation or individual becoming a Developer Partner in its sole discretion."*

**⚠ Can a UK company join without an ABN or an Australian entity? — the load-bearing question**

| Question | Answer | Evidence |
|---|---|---|
| Is an ABN required? | **No ABN requirement is stated anywhere** in the Terms, the eligibility page, or the registration guidance | [T&Cs clause 1](https://developer.myob.com/program/terms-conditions/business-api-tandcs/); [become-a-partner](https://developer.myob.com/become-a-myob-developer-partner/) |
| Is an Australian entity required? | **Not stated.** *"Developer means an individual, company, organisation, partnership or other corporate entity…"* | T&Cs, Definitions |
| Counterparty and governing law | **MYOB Australia Pty Ltd**; *"governed by the law of the State of Victoria, Australia"* | T&Cs |
| Practical friction | Fees are quoted in **AUD including GST**, and registration runs through `my.myob.com.au`. GST-inclusive pricing to a non-resident is unusual — expect a billing conversation | [Benefits table](https://apisupport.myob.com/hc/en-us/articles/5210075263759-MYOB-Developer-Program-Benefits) |

> **Verdict: a UK company can apply on the face of the published rules — no ABN or AU entity is a stated prerequisite. But this is "not prohibited", not "confirmed permitted". MYOB has absolute discretion (clause 3), and no positive confirmation that a foreign entity has been admitted could be found. Treat as an open risk to close in writing at application.**

**Security obligations** — the [MYOB Developer Security Requirements](https://developer.myob.com/program/security-requirements/) are contractual and *"aligned to the **DSPANZ Security Standard for Add-on Marketplaces**"*: OAuth 2.0 mandatory; refresh tokens encrypted at rest with AES-128 or greater, key in a separate config file; **TLS 1.2 with AES-256 and SHA-256**; 302 redirects for token-bearing URLs; **MFA mandatory**; NIST crypto at rest; **audit logs kept a minimum of one year, immutable and secure**.

> ⚠ **Data hosting — the requirement that will shape the AU architecture.**
> *"Ensure client data is not hosted in high-risk areas. **Australia and New Zealand are considered low-risk areas. Please contact MYOB in the event of data being stored anywhere other than Australia and New Zealand. MYOB may need to contact government bodies for advice and exemptions.**"*
>
> **A UK-hosted stack is not banned, but it is an escalation** — you must notify MYOB, and MYOB may need government advice or exemptions. **Budget for an ap-southeast-2 (Sydney) region before the AU launch and treat "AU data stays in AU" as the default answer.** ⚠ Note this compounds the residency tension already flagged in §3.4 (the team works from Bangladesh, and `privacy-notice.md` §7.4 has an unresolved cross-region backup placeholder).

**Evidence MYOB can demand (clauses 37–46):** written infosec, incident-response and access-control policies; on request, *"summaries of penetration tests, vulnerability assessments, certifications or independent audits (for example, ISO 27001, SOC2)"* and *"a description of the system architecture and data flows"* (clause 40); ⚠ **security incident notification within 24 hours** in writing (clause 41 — the same 24-hour clock as Intuit, again tighter than UK GDPR); audit rights *"no more than twice per year"* (clause 44). **No pen-test certificate or insurance is required up front** — it is on demand. Whether MYOB requires insurance at any tier: **not verified**.

> ⚠⚠ **THREE AI CLAUSES THAT DIRECTLY CONSTRAIN THIS PRODUCT** — all in the 12 March 2026 Terms, and collectively the most consequential contractual language in this entire document:
>
> - **Clause 17(b):** *"You must not… use API Data to create, train, fine tune, adapt, or enhance any AI Models."* (No training on MYOB-derived data — including your own models. **Same substance as Xero's prohibition.**)
> - **Clause 32:** if you use third-party AI (explicitly *"public cloud AI services and LLM APIs"*) with MYOB Data, you must ensure use is *"strictly limited to providing the specific User-visible functionality"*, the provider is **"contractually prohibited from using MYOB Data or Derived Data to train, fine-tune, improve or commercialise its AI Technologies"**, and data is handled per the Security Requirements. **→ Enterprise zero-retention terms from your model vendor satisfy this — but you need the paper, and you need it before you apply.** *(This is the clause Intuit leaves silent, §1.2.2 — MYOB tells you exactly what is required.)*
> - **Clause 34:** *"You must not operate, expose or offer any model-context, agent-orchestration or similar protocol server (**including, without limitation, any implementation of the Model Context Protocol ("MCP")**) or other API-brokering layer that: a. wraps or proxies MYOB Products, the Platform or MYOB APIs as generic tools or capabilities for use by third-party agents, models or applications outside Your Application."*
>
> **Reading for Neoting:** a chat-first product is fine. An internal tool layer used *only* by Neoting is arguably fine — it is not "for use by third-party agents… outside Your Application". **Exposing a Neoting MCP server that customers or third-party agents can call is prohibited.** If an MCP surface is ever on the roadmap, **carve MYOB out of it**, and get the reading confirmed in writing. Clause 42(b) adds that MYOB monitors for *"behaviour indicative of LLM-related misuse, bulk data extraction or other high-risk activity"*.

**Other notable terms:** clause 10 — you must **finish the integration within 6 months** of membership or notify MYOB, else keys may be deactivated. Clause 61 — MYOB's liability to you is capped at **24 months of membership fees**. Clause 64 — credentials unused for 12 continuous months are deactivated. Clause 50 — **MYOB explicitly reserves the right to build a competing product.**

#### 1.6.3 Certification, app review, marketplace listing

- **Production access does NOT require certification.** Keys are live on issue; the only gate is developer-account approval.
- **Certification is a *tier benefit*, not a requirement**: Developer Partner allows MYOB to test and certify **two** solutions; Premium, unlimited.
- ⚠ **Marketplace listing is not available on the entry tier at all** — the benefits matrix shows it blank for Developer Access, "Y" for Developer Partner and Premium.
- **Listing process:** email `ecosystem@myob.com`; MYOB reviews value proposition, target market, integration walkthrough, **OAuth validity**, **company file access working**, information flow, and **logo/brand compliance** ([add-on listing](https://developer.myob.com/program/add-on-listing-on-myob-com/)).
- **Not verified:** review duration, listing fee, revenue share. None are published. The Marketplace lists 350+ apps.

#### 1.6.4 ⚠ Limits before certification — the opposite of the Xero pattern

| Limit | Number | Source |
|---|---|---|
| **Cap on connected company files for an uncertified/unlisted app** | **None found. No documented maximum.** | Terms, security requirements and all MYOB API help-centre articles reviewed |
| **Minimum users required before MYOB will list you** | **"Prior to MYOB listing Your Application on the MYOB App Marketplace, you must have at least 5 Users utilising your Integration."** (clause 11) | [T&Cs](https://developer.myob.com/program/terms-conditions/business-api-tandcs/) |
| API keys auto-active per developer account | **2** | [article 360000490416](https://apisupport.myob.com/hc/en-us/articles/360000490416-Why-are-my-API-Keys-inactive) |
| Time to complete integration before keys may be revoked | **6 months** (clause 10) | T&Cs |
| Idle-key deactivation | **12 months** (clause 64); MYOB mass-cancelled unused keys effective 6 Feb 2023 | T&Cs |
| **DSPANZ SSAM annual self-assessment trigger** | **>1,000 connections to AU small business customers, OR ANY connection to the practice client list of an Australian tax or BAS agent** | [SSAM PDF](https://dspanz.org/media/website_pages/best-practice/addon-security-standard/ABSIA-Security-Standard-for-Add-on-Marketplaces.pdf) |

> ⚠ **The SSAM second trigger has no volume threshold, and Neoting hits it on day one.** Neoting connects to *practice client lists*. **The annual self-assessment obligation applies from the first practice client, not at 1,000 connections.** Non-compliance path: written notice giving 30 days to advise a treatment plan and up to a further 60 days to complete the work.

**So: MYOB will not stop you connecting company file #200. It will stop you being *listed* until you have 5 live users. The commercial gate is the monthly fee, not a connection cap.**

#### 1.6.5 Auth model

**OAuth 2.0 authorization code**, plus an optional second credential layer.

| Item | Value |
|---|---|
| Authorize | `https://secure.myob.com/oauth2/account/authorize` |
| Token / refresh | `https://secure.myob.com/oauth2/v1/authorize` — **POST only** |
| **Access token** | **1200 seconds = 20 minutes** |
| **Refresh token** | **Up to 1 week** (reduced from 1 year on 29/01/2020) |
| Rotation | **Yes — rotating** |
| Auth code | **Single use** |

Source: [token lifetimes](https://apisupport.myob.com/hc/en-us/articles/360000478675-How-long-do-access-tokens-refresh-tokens-last).

> ⚠ **A 1-week refresh token in a batch-posting product is a real operational hazard, and it is by far the shortest in this document.** (Compare Xero's 60 days and Intuit's 100.) If a practice's connection sits idle over a holiday period **it dies silently** and a human must re-consent. **Build a keep-alive refresh (e.g. every 24h) and a re-consent nudge into the product from day one** — this is not optional on MYOB.

**Scopes — there was a hard cutover on 12 March 2025.** Keys created after that date **must** use granular scopes and **the `CompanyFile` scope will no longer work**; keys created before must use `CompanyFile` and cannot use the new scopes ([Getting started](https://apisupport.myob.com/hc/en-us/articles/6908884026895-Getting-started)). **For Neoting's purchase-side flow:** `sme-purchases sme-contacts-supplier sme-general-ledger sme-banking sme-company-file` (add `sme-company-settings` for preferences). **Do not request payroll.**

> ⚠ **Since March 2025, only Admin users of a company file can approve OAuth consent** ([article 13052864214671](https://apisupport.myob.com/hc/en-us/articles/13052864214671-OAuth2-0-Authentication-Now-Requires-Admin-Access)). **Your onboarding must route consent to the file admin, which in a practice context may be the client, not the bookkeeper.** That is a materially different consent journey from Xero's and it should be designed deliberately.

**Required headers:**
```
Authorization:      Bearer [ACCESS_TOKEN]
x-myobapi-key:      [your API key]
x-myobapi-version:  v2
x-myobapi-cftoken:  [Base64(username:password)]     ← conditional
```

> ⚠ **`x-myobapi-cftoken` — verified, and the nuance matters.** *"Some MYOB files require a second level of user details… **NOTE: Not every file requires the CFTOKEN to be passed**, you will need to communicate with the MYOB Client and confirm how they log into their Company file."* If the end-user has SSO enabled, cftoken is not required ([CFTOKEN explained](https://apisupport.myob.com/hc/en-us/articles/5772115953679-CFTOKEN-explained)).
>
> **This is a genuine multi-tenant design problem with no UK analogue.** For some clients you will store a *second* credential per company file — a username/password base64'd on every call. **That is a secret with no rotation story, no expiry, and no revocation channel other than the client changing it.** Encrypt per tenant, never log the header, and **prefer onboarding clients onto my.MYOB SSO so cftoken is unnecessary.** Note this does not fit Neoting's `Integration.tokenRef` single-pointer shape without extension — a LAW change (G7).

**Per-client connection management:** your developer account's email must be **invited to each client's company file** by the client (practices can invite you as advisor). **You do not need an AccountRight subscription** to access a file you've been invited to. `GET https://api.myob.com/accountright` returns the list of company files you have been invited to.

#### 1.6.6 The API surface

**Bill endpoints:** `/{cf_uri}/Purchase/Bill/{Service|Item|Professional|Miscellaneous}`. **Service Bill is the workhorse** for document-to-bookkeeping (account + description + total per line, no inventory item required). Account and tax code are set per line as object references, with `IsTaxInclusive` at header level.

⚠ **"The API does not support consolidated tax codes, this is an in-product feature only"** — `GET /GeneralLedger/TaxCode` will simply not return them ([Consolidated Tax Codes](https://apisupport.myob.com/hc/en-us/articles/6217191733135-Consolidated-Tax-Codes)). **If an AU client uses a consolidated code, your coding engine has no API-visible target for it.** Handle explicitly rather than failing obscurely.

> 💷 **Money-as-decimal: every money field on a Bill is `Decimal 13.2`** ([Service Bill docs](https://developer.myob.com/api/myob-business-api/v2/purchase/bill/bill_service/)) — line `Total`, header `Subtotal`, `Freight`, `TotalTax`, `TotalAmount`, plus every `*Foreign` variant.
>
> 1. **Serialise from integer cents to a fixed 2-dp decimal string** — never let a float reach the JSON.
> 2. **Deserialise by string-parsing, not float-parsing.** MYOB echoes computed `TotalTax`/`TotalAmount`; parse to integer cents and reconcile before Approve.
> 3. ⚠ **`IsTaxInclusive` flips the meaning of every `Total` on the request.** Get it wrong and you are out by the GST amount, not by a cent.
> 4. ⚠ **MYOB itself has a documented rounding defect** — help article *"Invoice rounding causing a 1 cent variation"* ([5197141465615](https://apisupport.myob.com/hc/en-us/articles/5197141465615-Invoice-rounding-causing-a-1-cent-variation)). **Assume MYOB's computed tax can differ from yours by 1c** and decide the reconciliation policy up front — posting exclusive with explicit line totals is safer than letting MYOB derive them.

##### ✅ D43 — attaching the source document: YES, on Bills and on Spend Money

| | Bills | Spend Money |
|---|---|---|
| Endpoint | `/Purchase/Bill/{Layout}/{UID}/Attachment` | `/Banking/SpendMoneyTxn/{UID}/Attachment` |
| Body | `{"Attachments":[{"OriginalFileName":"x.pdf","FileBase64Content":"…"}]}` | identical |
| **Max size** | **"less than 3MB"** (base64-encoded) | same |
| **Accepted types** | **PDF, TIFF, JPG, JPEG, X-MS-PNG, PNG** | same |
| Per request | **One document per request** | one per request |
| Source | [Bill's Attachments Endpoints](https://apisupport.myob.com/hc/en-us/articles/360004087795-Bill-s-Attachments-Endpoints) | [Spend Money Attachment](https://apisupport.myob.com/hc/en-us/articles/360001882855-Spend-Money-Attachment-Endpoint) |

⚠ GET returns `ThumbnailUri` and `FileUri` as S3 pre-signed URLs that **expire after 1–2 minutes**. **Never persist those URLs**; re-fetch on demand.

> ⚠ **3MB, base64 — the tightest attachment limit in this document.** Base64 inflates by ~33%, so the *raw* file budget is roughly **2.2MB**. **Phone photos of receipts routinely exceed this**, and Neoting's primary intake channel is a phone camera. **Build a downscale/re-encode step into the pipeline** (target ≤2MB raw, PDF or JPEG). **No HEIC and no WEBP** — iPhone captures must be transcoded. *(Neoting already accepts HEIC at intake per SoT §24.2, so the transcode step is a real, specific piece of work.)*

⚠ Attachments exist on **Bills and Spend Money only** — no attachment sub-resource on Sales Invoices or Purchase Orders.

> ⚠⚠ **CRITICAL PRODUCT GAP — MYOB Business Connected Ledger has NO Bills via the API.** Per the [MYOB Product/API Matrix](https://apisupport.myob.com/hc/en-us/articles/4824719330959-MYOB-Product-API-Matrix) *(article updated Dec 2022 — re-verify before build)*:
>
> | Entity | Connected Ledger | Business Lite | Business Pro | AccountRight Plus/Premier |
> |---|---|---|---|---|
> | **Bills** | *(none)* | Bill, Item, Service | Bill, Item, Service | + Professional, Miscellaneous |
> | **Spend Money + Attachments** | **✓** | ✓ | ✓ | ✓ |
> | Purchase Orders | *(none)* | ✓ | ✓ | ✓ |
>
> **Connected Ledger is the cheap practice-channel SKU that accountants put clients on** — it does not appear on the [retail pricing page](https://www.myob.com/au/pricing). **If a meaningful share of target practices' clients sit on Connected Ledger, the only document-to-ledger path is Spend Money + Spend Money Attachment.** Design the posting engine with a **Bill / SpendMoney fallback from day one**, driven off `UIAccessFlags` and a capability probe. **Do not assume Bills.** *(This is the MYOB analogue of Xero's ledger/cashbook exclusion in §1.1.5 — on both platforms, the cheap practice SKU is where the API gets thin.)*

**⚠ Idempotency: there is none**, and the safety net was removed — since AccountRight 2022.8, POSTing with a UID returns **400 Bad Request** (`UidInPostRoute`) rather than upserting ([Changes to POST requests](https://apisupport.myob.com/hc/en-us/articles/5319928281871-Changes-to-POST-requests)). Concurrency uses optimistic locking on `RowVersion` (**409 IncorrectRowVersionSupplied** on a stale PUT).

> ⚠ **Combined with a 29-second server timeout, a timed-out POST is genuinely ambiguous — you cannot tell "not created" from "created, response lost".** Neoting must maintain its own dedupe ledger: store the intent key, and **on timeout re-query `/Purchase/Bill/Service?$filter=…` on supplier + date + reference before retrying.** This is mandatory, not optional, and it is a specific behaviour the `LedgerAdapter` must encode.

**No webhooks.** *"While we don't currently support Webhook, you can use different filters such as 'LastModified'"* ([source](https://apisupport.myob.com/hc/en-us/articles/6258012443791-Does-MYOB-support-webhooks)). **Bank-matching and status reconciliation must be poll-driven** — a meaningful architectural difference from Xero and QBO, both of which certify on webhooks.

#### 1.6.7 Rate limits and quotas

| Item | Value |
|---|---|
| **Published rate limits** | ⚠ **NOT PUBLISHED. Not verified.** `developer.myob.com` has no limits page |
| Where limits actually appear | **Per-app, in the my.MYOB Developer Dashboard** — *"information about app usage, quotas and limits"* |
| Limits vary by membership tier | Yes — *"you get much higher API Access rates"* as a tier benefit |
| **Request timeout** | **29 seconds** (since June 2021) |
| Anti-abuse | MYOB reserves the right to rate-limit against bulk extraction / LLM misuse (clause 42(b)) |

**Do not size the AU rollout without asking MYOB for the numbers in writing.** MYOB actively encourages caching to stay within key limits ([Data Sync Tips](https://apisupport.myob.com/hc/en-us/articles/360001577215-Data-Sync-Tips)) — cache chart of accounts, tax codes and preferences per company file. **Per-company-file limits: not verified.**

#### 1.6.8 Sandbox / test access

- **Shared sandbox company file** — included at *every* tier. Request by support ticket.
- ⚠ **It is genuinely shared:** *"this is a shared sandbox file managed by MYOB and the data will be visible to other users of the file. So, please make sure to use test data only."* Login is `APIDeveloper` with a **blank password**, shared across all developers ([Shared Sandbox Files](https://apisupport.myob.com/hc/en-us/articles/6262111820815-Using-our-Shared-Sandbox-Files)). **Never place real or realistic client data there.**
- **Private sandbox requires a paid tier:** Developer Partner gets full AccountRight with **10 company file licences**; Premium gets **20**.
- ⚠ **Same host, same keys as production. There is no separate sandbox host.** A misconfigured tenant can hit a live file — **enforce a file-UID allow-list in your own code.**
- ⚠ **T&Cs clause 30:** sandbox environments *"may contain only synthetic, sample or de-identified data and must not be used by you to store or process live customer or practice data."*

#### 1.6.9 Costs — MYOB charges, and it charges monthly

| Benefit | Developer Access | Developer Partner | Premium |
|---|---|---|---|
| **Cost** | **A$110/m** | **A$220/m** | **A$630/m** |
| MYOB Business API access | ✓ | ✓ | ✓ |
| **AccountRight Live API access** | **✓** | **✓** | **✓** |
| AccountRight software | Shared sandbox only | Full (**10 files**) | Full (**20 files**) |
| Consulting | 1 hr/quarter | 1 hr/month | 1 hr/month |
| **Marketplace listing** | **—** | **✓** | **✓** |
| Certified solutions | — | **2** | unlimited |

Source: [Developer Program Benefits](https://apisupport.myob.com/hc/en-us/articles/5210075263759-MYOB-Developer-Program-Benefits), article updated **2025-01-31** — prices likely to move; re-verify. **"Prices include GST and API membership is charged monthly."**

- **Revenue share: not published. Not verified.** **Listing fee: not published. Not verified.**
- Monthly, no minimum term stated; *"Fees are non-refundable and non-transferable"*; 20 days' notice of fee changes.

> **Important correction to a common assumption:** **AccountRight API access is not gated behind the higher tiers.** The current matrix shows AccountRight Live API access on all three. You can build the full AccountRight + MYOB Business integration on **A$110/month**, upgrading to A$220 for your own sandbox files, certification and a listing.
>
> **Realistic first-year MYOB cost: A$2,640** (Developer Partner, 12 months). **That is trivially cheap relative to the market — the real costs are the 5-user listing gate and the data-residency work.**

#### 1.6.10 Timeline

| Phase | Elapsed | Gate |
|---|---|---|
| Application → developer account live | **Same day to 3 business days** — **but add 1–3 weeks** if MYOB pushes back on the clause 1(d) case study or on a UK entity | Manual review, sole discretion |
| API key registered | **Minutes** (self-service) | — |
| Sandbox invite | 1–3 business days | — |
| Build against sandbox (OAuth + rotating refresh, cftoken, file discovery, Service Bill + Attachment, **Spend Money fallback**, dedupe ledger, 29s-timeout reconciliation) | **4–8 weeks** | 3MB/MIME transcoding and the Connected Ledger fallback are the non-obvious work |
| ⚠ **AU data-residency work** (stand up ap-southeast-2 or get written MYOB sign-off for UK hosting) | **3–8 weeks, parallel** | **Likely the critical path, not the API** |
| DSPANZ SSAM self-assessment (triggered on day one) | 2–4 weeks | Annual thereafter |
| First real client company file | Days, once a design-partner practice is signed | **Admin** user consent required |
| Marketplace listing | + however long **5 live users** takes, then MYOB review (duration not published) | Developer Partner tier or above |

**Realistic: 8–14 weeks from application to a real posted, attached bill in a live AU client ledger**, assuming a design-partner practice is lined up and AU hosting is decided early. Marketplace listing is a separate, later milestone and **is not required to go live**.

### 1.7 MYOB AccountRight

Everything in §1.6 applies — same programme, fees, OAuth, entities and `Decimal 13.2`. This section covers **only the differences**.

#### 1.7.1 The deprecation picture, untangled

| Thing | Status as at Sep 2026 |
|---|---|
| **AccountRight Live API v1** | **DECOMMISSIONED 9 April 2020** |
| **AccountRight Live API v2** | **CURRENT** — renamed the **MYOB Business API**; docs 301-redirect |
| **Old MYOB Essentials API** | **LEGACY, dying by migration** — an upgraded file can no longer use it |
| **MYOB Business API (unified)** | **The one to build against.** `x-myobapi-version: v2` |
| MYOB Acumatica (ex-Advanced), MYOB EXO | Separate APIs and programmes; EXO gated to existing EXO partners |
| MYOB Transactions API | Bank-feed ingestion **for financial institutions only**. Not relevant |

**Bottom line: there is no "AccountRight API" to choose any more. There is one API, and AccountRight is one of the products behind it.** What differs is *transport* and *feature surface*.

#### 1.7.2 ⚠ The company-file location problem — the defining constraint

Three base endpoints exist:
```
https://api.myob.com/accountright              ← ONLINE (cloud) files
http://localhost:8080/accountright/            ← LOCAL, same machine
http://[IP]:8080/accountright/                 ← LOCAL, over LAN
```

| | **Online file** | **Local file (AccountRight Server Edition)** |
|---|---|---|
| **API key required?** | Yes | **No** |
| **OAuth required?** | Yes | **"No API key or OAuth is required for local API"** |
| Auth mechanism | Bearer + key + conditional cftoken | **`x-myobapi-cftoken` only** |
| Token refresh | Every 20 min | **"No token refresh is needed"** |
| Transport | HTTPS | **HTTP, plaintext, port 8080** |
| **Reachable from your SaaS?** | **Yes** | **No — it is inside the client's network** |

Source: [Local API User Guide](https://apisupport.myob.com/hc/en-us/articles/12848911096591-Local-API-User-Guide) (updated 2025-05-29).

> ⚠⚠ **Strategic call for Neoting: support ONLINE AccountRight files only, at least for v1.**
>
> The local path requires software installed on the client's machine, a **plaintext HTTP endpoint on port 8080**, a locally-created non-SSO user, and network reachability from your cloud. **That is an on-prem agent product, not a SaaS integration** — and it is flatly incompatible with MYOB's own TLS 1.2 mandate across anything but a LAN.
>
> **Detect and refuse gracefully.** Read `UIAccessFlags` from the company file — **`0` = Local AccountRight, `2` = Essentials (New), `3` = AccountRight & AccountRight Browser** ([UI Access Flag](https://apisupport.myob.com/hc/en-us/articles/360001395156-UI-Access-Flag-for-Product-Determination-via-the-AccountRight-API)). Flag `0` → tell the practice the client file must be moved online. **This is a normal MYOB conversation; practices do it routinely.**

⚠ **cftoken applies to online files too.** MYOB's own docs show *"standard headers for an **Online** file that requires the CFTOKEN header"*. An online AccountRight file whose users were created the old way still demands it. **Your onboarding must ask the practice how each client signs into the file.**

#### 1.7.3 Feature surface and version churn

AccountRight Plus/Premier expose **all five** Bill layouts; MYOB Business Lite/Pro expose only **Item and Service**; **Connected Ledger exposes none**. **Service Bill is the safe common denominator across Lite, Pro, Plus and Premier** — build to that and fall back to Spend Money for Connected Ledger.

⚠ **MYOB decommissions older AccountRight releases on a rolling ~monthly cadence and expects your app to keep up** — *"If you're still on AccountRight 2026.1, please make sure to update by 31st March 2026"*. Contractually: *"you must support new Platform features, changes and updates within Your Application by the end of Your next release"* (clause 14(h)). **The good news:** recent releases all state *"There are no public updates to the API with this release"* — the v2 API surface is stable and the churn is in the desktop client. **There is no changelog feed and no webhooks**; the [Developer Update articles](https://apisupport.myob.com/hc/en-us/sections/) and the newsletter are the only change channel.

### 1.8 Reckon

Three products, three integration stories. **Only Reckon One is a viable target.**

| Product | Technology | Verdict |
|---|---|---|
| **Reckon One** (cloud) | **RESTful JSON, OAuth 2.0, OData v4.0.** v2 current. Sold in **AU / NZ / UK** | ✅ **The target.** Bills + attachments both exist |
| **Reckon Accounts Hosted** (AWS-hosted desktop) | *"The Reckon Accounts SDK wrapped in a RESTful API"* — QBXML under a REST envelope | ⚠ Possible but expensive |
| **Reckon Accounts Desktop** (formerly QuickBooks Australia) | **QuickBooks SDK v6.1 / qbXML**; requires **Reckon Web Connector** on the client machine. **No REST API** | ❌ On-prem agent product. Out of scope |

Sources: [developer.reckon.com/api-products](https://developer.reckon.com/api-products), [Hosted API FAQ](https://help.reckon.com/article/z1jxmox1yz-api-reckon-accounts-hosted-faq). *(Confirmed: Reckon Accounts Desktop is QuickBooks-derived — "based on the Intuit QuickBooks® source code".)*

#### 1.8.1 Application path

1. **Free Reckon Developer Partner account** — [developer.reckon.com/signup](https://developer.reckon.com/signup).
2. **Application form** (Typeform) — ⚠ *"You can only select one Reckon API product per application form."* Reckon One and Reckon Accounts Hosted need **separate submissions** ([Application Form](https://help.reckon.com/article/c7aga6zajn-reckon-api-application-form)).
3. **Approval** → ClientID, ClientSecret, redirectURI and a **subscription key**.
4. Test via the portal console + published **Postman collection**.
5. Build. 6. Marketplace listing by support ticket. 7. SSAM assessment.

#### 1.8.2 What Reckon demands

Legal business name, trading name, business address, website, **business email address** — ⚠ **generic domains (Gmail/Outlook/Hotmail) trigger automatic rejection** — product overview, target industry, data types, deployment model, existing Reckon account, and callback URL.

> **ABN / Australian entity: no requirement stated.** No ABN field, no entity-nationality question, **no security questionnaire at application**. **Reckon One is explicitly sold in AU, NZ and UK**, so a UK company is a natural applicant. **Reckon is materially easier for a UK entity to join than MYOB.**

**No pen-test evidence, no insurance, no named security contact, no data-residency commitment at application.** Security obligations arrive later via SSAM. Whether Reckon imposes residency terms in its developer agreement: **not verified** (the agreement is not published).

#### 1.8.3 Certification and listing

**No certification is required for production** — credentials are live on approval. **Marketplace listing is optional and separate**, by support ticket after demonstrating a working integration, reaching *"over 600,000 potential users"*. **What commonly fails:** the only documented failure mode is the **generic email auto-rejection**. Review criteria and duration: **not published, not verified.**

#### 1.8.4 ⚠ Limits before certification

| Limit | Number |
|---|---|
| Cap on connected books for an unapproved app | **None documented. Not verified** |
| **SSAM advanced security assessment trigger** | *"requires a third-party application provider to undergo an advanced security assessment when you surpass **1000 customer connections**"*, conducted and passed **annually** to remain listed ([get-started](https://developer.reckon.com/get-started)) |
| **The underlying SSAM scope Reckon's page omits** | *">1,000 connections to Australian small business customers of a DSP, **or is connected to the practice client list of an Australian tax or BAS agent**"* ([SSAM PDF](https://dspanz.org/media/website_pages/best-practice/addon-security-standard/ABSIA-Security-Standard-for-Add-on-Marketplaces.pdf)) |
| Non-compliance remedy window | **30 days** to advise a plan, **up to a further 60 days** to complete |
| Attachments per transaction | **3 files max, each ≤10MB** |

> ⚠ **Same trap as MYOB: the 1,000-connection number is the headline, not the whole rule.** SSAM's practice-client-list limb has **no volume threshold**, so a practice-facing product is in scope from the first practice. **Reckon's own page advertises only the 1,000 figure — you need the DSPANZ source to see the second trigger.** Prepare the SSAM self-assessment before AU launch.

#### 1.8.5 Auth model

OAuth 2.0 authorization code; authorize `https://identity.reckon.com/connect/authorize`, token `https://identity.reckon.com/connect/token`. Scopes `openid`, `read`, `write`, `offline_access`. **Access token lifetime for Reckon One: not verified** (Hosted is **180 minutes**). **Refresh token lifetime and rotation: not verified.**

⚠ **Subscription key is mandatory** — *"Sending subscription key in each payload is mandatory for Reckon One API v2."* It is **per developer, per API product — not per app and not per tenant** ([Subscription Key](https://help.reckon.com/article/4sbjc35dqt-subscription-key)).

> ⚠ **Reckon is more forgiving than MYOB on token lifetime and has no per-company-file password. But the subscription key is a single shared secret across your entire AU book of business**, and it is what Reckon uses to attribute and throttle your traffic. **Treat it as a top-tier secret, never expose it client-side, and never put it in the query string in production if a header will do** — URL params land in logs.

**Tenant discovery:** `GET https://api-v2.reckonone.com/books`. ⚠ **Call `GET /{bookId}/permissions` before you post** — Reckon returns a **403 with a `requiredPermissions` array**, so check at connect time rather than failing at Approve.

#### 1.8.6 The API surface

Base URL **`https://api-v2.reckonone.com`** ([OpenAPI spec](https://api-v2.reckonone.com/swagger/v2/swagger.json) — 558 documented operations, complete and machine-readable).

**`POST /{bookId}/bills`** requires `supplier`, `billDate`, `amountTaxStatus`, `lineItems`; returns **201** with the bill id.

Two properties that are **better than MYOB** for a coding engine:
- **`ledgerAccount` accepts the id *or* the full name** (`"Income:Sub income"`). ⚠ **Prefer GUIDs in production** — names are user-editable and will silently break.
- ✅ **`taxRate` is a plain string and `taxAmount` can be supplied explicitly per line.** **You can pin the tax to the cent rather than letting the platform derive it** — materially better than MYOB, and the right choice for a product that has already reconciled the document.

⚠ `amountTaxStatus` is `Inclusive`/`Exclusive` — the same flip-risk as MYOB's `IsTaxInclusive`.

> 💷 **Money-as-decimal — and this is worse than MYOB.** Every money field is JSON `"type": "number"`, `"format": "decimal"` (verified in the OpenAPI schema) — **but there is no declared scale.** A JSON `number` is a float in most parsers, so `110.10` can round-trip as `110.09999999999999`.
>
> **Mitigations:** serialise from integer cents to a decimal literal with exactly 2 dp; ⚠ **parse responses with a decimal-aware JSON reader** (`json-bigint`-style handling in Node), **never a default float parser**; supply `taxAmount` explicitly so Reckon does not derive it; reconcile `totalAmount` against your integer-cents total before releasing Approve. **This is the single most float-hazardous API in this document.**

##### ✅ D43 — Reckon One can attach the source document

| | Detail |
|---|---|
| Endpoint | **`POST /{bookId}/bills/{billId}/attachments`** |
| Mode A | Single document: **raw binary in the body**, filename via query string |
| Mode B | **MIME multipart, up to 3 documents** in one request |
| **Max size** | **10MB per file** |
| **Max count** | **3 files per transaction** |
| **Accepted types** | `.docx .doc .xls .xlsx .tiff .pdf .jpg .jpeg .png .gif` |
| Prerequisite | Transaction must be **saved first** |
| Module gate | ⚠ Requires the **"Invoice and Bill medium module"** |
| Attachable to | ⚠ **Bills and Payment transactions only** |
| Irreversible | *"It is not possible to retrieve a file once it is deleted"* |

Sources: [OpenAPI spec](https://api-v2.reckonone.com/swagger/v2/swagger.json), [Document Storage](https://help.reckon.com/article/0z6gx2y6w8-document-storage).

> ⚠⚠ **The single nastiest gotcha in the Reckon API, and it will silently break D43 if you miss it:**
>
> > *"Note that this endpoint will return **200 OK** as the response. Be sure to check the response body for the response for each document that was sent."*
>
> The body is `{"list":[{"fileName":"…","code":201,"error":"…","id":"…"}]}`. **A 200 does not mean the attachment succeeded.** A naive `if (response.ok)` **will mark documents as attached that were rejected**. **The D43 assertion must read the per-item `code == 201` and treat anything else as a failed release.** Given `LedgerPublishSuccess.attachmentSent` already exists in Neoting's adapter interface (§4.1), this is exactly the field that must be driven off the per-item code — not off the HTTP status.

**Better than MYOB on attachments:** **raw binary, not base64** (no 33% inflation), a **10MB ceiling vs MYOB's effective ~2.2MB**, and Office formats and `.gif` accepted. **But — like MYOB — no HEIC and no WEBP.** Transcode phone captures.

**Idempotency: none documented.** No idempotency-key header in the OpenAPI spec; **not verified** whether Reckon dedupes. Neoting must own dedupe via an OData pre-check on supplier + reference + date. **Query capability is good** — OData v4.0 filtering, paging, selecting, sorting, plus PATCH. **Webhooks: none found. Not verified; assume polling.**

#### 1.8.7 Rate limits, sandbox, costs, timeline

**Rate limits: not published, not verified.** The API sits behind **Azure API Management**, which throttles by subscription key by default — so limits almost certainly exist and are attributed to your **single per-developer key across all tenants**. **Ask `apisupport@reckon.com` in writing before sizing the AU rollout, and implement 429 back-off with `Retry-After` regardless.**

**Sandbox: no dedicated environment is documented.** Reckon provides **test licences** and a real Reckon One book. Tooling: portal console, [Postman collection](https://help.reckon.com/article/wktfz1006b-reckon-one-postman-collection), [Swagger UI](https://api-v2.reckonone.com/swagger/index.html), sample app. ⚠ **Same host, same keys as production — enforce a book-GUID allow-list in your own code.**

**Costs: the developer programme is FREE** — *"Sign up to create a **free** Reckon Developer Partner account"*, described as "no-cost membership" with documentation, portal access, free support and test licences. **Listing fee and revenue share: not published, not verified.** ⚠ **The SSAM annual assessment is your cost** — Reckon does not fund it.

**Timeline: realistic 5–9 weeks** from application to a posted, attached bill in a live Reckon One book. Faster than MYOB — no residency negotiation, no company-file password layer, no tier fee, and a complete published OpenAPI document. (Approval turnaround itself is **not published — assume 3–10 business days**.)

### 1.9 The Australian market in context

**Australia is not "the UK with different tax codes" for this product. Three things are different and all three are structural.**

#### 1.9.1 Who actually holds the ledgers

| Platform | Position in AU | Evidence |
|---|---|---|
| **Xero** | **The default.** ANZ segment: **2.8 million customers**, revenue **NZ$1.4bn** (+18%), ARPC **$48.89**, group average monthly churn **1.14%** — FY26, year ended 31 March 2026 | [Xero FY26 ASX Release](https://brandfolder.xero.com/NE531UQB/as/nvrr7wvj8fpp7rkgf9ww7w/Xero_FY26_ASX_Release) |
| **MYOB** | The incumbent, strongest in **larger SMEs, desktop-heritage clients and practice compliance**. Claims *"hundreds of thousands of organisations"*. Owns a full practice stack | [myob.com/au/about](https://www.myob.com/au/about) |
| **Reckon** | ASX-listed, niche but real. Claims reach of *"over 600,000"* businesses. Strong in **long-tail desktop** (ex-QuickBooks AU since 1994) | [developer.reckon.com/get-started](https://developer.reckon.com/get-started) |
| **QuickBooks Online** | Present and marketed in AU with QBOA and the ProAdvisor Program. **Third player**, well behind Xero and MYOB | [quickbooks.intuit.com/au](https://quickbooks.intuit.com/au/) |
| **Sage** | ⚠ **Not verified as material** in the AU SME/practice segment. **Do not assume UK Sage relevance transfers** | — |

> **The single most useful implication for sequencing: a UK product that already has Xero and QuickBooks Online covers a very large share of AU practices on day one, because Xero AU and Xero UK are the same API with the same app registration.** The genuinely *new* AU work is **MYOB** — and MYOB is the one platform where you cannot reach the ledger without paying, applying, and negotiating residency.

#### 1.9.2 The compliance layer that has no UK equivalent

This is the part most UK entrants miss entirely.

1. ⚠ **DSPANZ SSAM (Security Standard for Add-on Marketplaces)** — co-developed by DSPANZ and the **ATO**, and deliberately harmonised across *"Xero Marketplace, Myob Add-ons, Intuit Apps and Reckon Marketplace"* ([SSAM PDF](https://dspanz.org/media/website_pages/best-practice/addon-security-standard/ABSIA-Security-Standard-for-Add-on-Marketplaces.pdf)). **One assessment, four marketplaces — do it once, properly, and reuse it.**
   - Trigger: **>1,000 connections to AU small business customers, OR any connection to the practice client list of an AU tax or BAS agent.**
   - ⚠ **Neoting hits the second limb immediately.** Budget for the annual self-assessment from launch.
   - **This also explains why Xero's and MYOB's security standards read almost identically** — both are aligned to SSAM. **Satisfying one substantially satisfies the other.**
2. ⚠ **The ATO Operational Framework** sits behind SSAM — DSPs must certify annually to the ATO and hand over a list of in-scope add-on developers, self-assessment dates, DSP approval, and *"details of any outstanding matters"*. **Your name goes on a list the ATO sees.** Treat the self-assessment as a regulator-facing document, not a vendor form.
3. **Data residency** — MYOB's AU/NZ expectation (§1.6.2). **Plan an AU region rather than arguing for a UK exemption.**
4. **Privacy Act 1988 (Cth)** and the **Spam Act 2003 (Cth)** are named in MYOB's Terms. **UK GDPR compliance does not automatically discharge these** — and the Spam Act matters directly, because Neoting's chase mechanism sends SMS.

#### 1.9.3 The competitive reality, and six things that will bite a UK team

**Dext and Hubdoc are already there.** Hubdoc is Xero-owned and bundled into Xero Business Edition plans in AU, so "receipt capture" is already nominally solved and free for a large share of the market. **Neoting's AU wedge is not capture — it is chat-first intake, coding quality, and the human Approve gate with D43 traceability. Position against Dext on workflow, not against Hubdoc on price.**

1. **GST is 10%, and tax codes are per-file and user-defined.** MYOB *consolidated* tax codes exist in the product but **not in the API**.
2. **BAS, not VAT returns.** ABN validation, and GST-free vs input-taxed vs N-T have no clean UK analogue.
3. **MYOB's `x-myobapi-cftoken`** — a per-company-file username/password on top of OAuth. **Nothing in the UK stack prepares you for storing a second, non-expiring, non-rotatable credential per tenant.**
4. **MYOB Connected Ledger has no Bills API.** Without a Spend Money fallback, a chunk of the practice channel is unreachable.
5. **20-minute access tokens and 1-week refresh tokens on MYOB.** Connections die over quiet periods.
6. ⚠ **MYOB clause 34 bans MCP/agent-brokering servers over its API, and clauses 17(b)/32 restrict AI training and third-party LLM use.** **For an AI-native product this is the most consequential term in either AU vendor's agreement. Read it before the architecture is fixed, not after.**

#### 1.9.4 MYOB vs Reckon, head to head

| | **MYOB (Business + AccountRight)** | **Reckon One** |
|---|---|---|
| Programme cost | **A$110 / A$220 / A$630 per month (incl GST)** | **Free** |
| Approval gate | Account approval, sole discretion; needs a MYOB case study (clause 1(d)) | Typeform, one product per form; no generic email |
| UK entity OK? | Not prohibited; **not confirmed** | **Yes in practice** — Reckon One is sold in AU/NZ/**UK** |
| Data residency | ⚠ **AU/NZ expected; must notify MYOB otherwise** | Not published — not verified |
| Auth | OAuth 2.0 + API key + **conditional `cftoken`** | OAuth 2.0 + **mandatory per-developer subscription key** |
| Access token | **20 min** | Hosted 180 min; Reckon One **not verified** |
| Refresh token | **1 week, rotating** | **Not verified** |
| Bill entity | `/Purchase/Bill/{layout}` — ⚠ **none on Connected Ledger** | `POST /{bookId}/bills` — uniform |
| **D43 attachment** | ✅ Yes — Bills and Spend Money | ✅ Yes — Bills and Payments |
| Attachment size | **<3MB base64** (≈2.2MB raw), **1 per request** | **10MB per file, 3 per transaction**, raw binary |
| Attachment gotcha | Pre-signed URLs expire in **1–2 min** | ⚠ **Returns 200 even on failure — check per-item `code`** |
| Money type | `Decimal 13.2` | JSON `number` / `format: decimal` (**no declared scale**) |
| Explicit tax amount | ✗ (derived; known 1c rounding issue) | ✅ **`taxAmount` per line** |
| Idempotency | **None**; POST-with-UID → 400; 29s timeout ⇒ ambiguity | **None documented** |
| Webhooks | **No** — poll on `LastModified` | Not found |
| Rate limits | **Not published** (my.MYOB dashboard) | **Not published** (Azure APIM) |
| Listing gate | **≥5 live users**; Developer Partner tier or above | Working integration + support ticket |
| AI terms | ⚠ **No training on API data; third-party LLMs contractually barred from training; MCP/agent-brokering banned** | **Not published — not verified** |
| **Time to live ledger** | **8–14 weeks** | **5–9 weeks** |

> **Two non-negotiable actions before any AU code is written:** (1) get MYOB's **written** position on a UK-domiciled applicant, UK/EU data hosting, and the clause 34 MCP reading; (2) get **published rate limits from both vendors in writing**. Neither is discoverable from documentation, and both are load-bearing.
### 1.10 Zoho Books

**Registration.** OAuth clients at the Zoho API Console, `https://api-console.zoho.com/`. Client types include Server-based, Client-based, Mobile, Non-browser and **Self Client** ([Zoho Books OAuth](https://www.zoho.com/books/api/v3/oauth/)). **For Neoting the correct type is Server-based**; Self Client is only useful for internal testing.

> ⚠ **Data-centre-specific domains — the single biggest UK/AU design constraint on this platform.** The Books API is served from **eight** DC domains, and the docs are explicit that you must swap the *domain*, not just the path ([Introduction](https://www.zoho.com/books/api/v3/introduction/)).

| DC | Books API base | Accounts server |
|---|---|---|
| US | `https://www.zohoapis.com/books/` | `accounts.zoho.com` |
| **Europe** | `https://www.zohoapis.eu/books/` | `accounts.zoho.eu` |
| **Australia** | `https://www.zohoapis.com.au/books/` | `accounts.zoho.com.au` |
| India / Japan / Canada / China / Saudi | `.in` / `.jp` / `.ca` / `.com.cn` / `.sa` | matching |

⚠ **A mismatch worth flagging:** Zoho's identity layer lists a **UK accounts server, `accounts.zoho.uk`** ([multi-DC guide](https://www.zoho.com/accounts/protocol/oauth/multi-dc.html)), but the Books API doc lists **no `.uk` API domain**. UK organisations therefore sit on the EU DC in the Books docs. **Engineering rule: never hardcode a base URL.** The redirect returns `location` and `accounts-server`; the token response returns `api_domain` — **persist `api_domain` per connection and route every call from it.** One Client ID works across all DCs, but each DC must be individually enabled in the API Console.

**Scopes.** Format `service.scope.operation`. Bills use `ZohoBooks.bills.{CREATE,UPDATE,READ,DELETE,ALL}`. **Attaching a file uses `ZohoBooks.bills.CREATE`** — there is no separate attachment scope. Listing a practice's client orgs uses `GET /organizations/user` with `ZohoBooks.settings.READ`.

**Token lifetimes.** Grant code 2 minutes; access token **1 hour**; **refresh token does not expire** — *"unlimited lifetime until it is revoked by the end-user"* (requires `access_type=offline`).

> ⚠ **Multi-tenant landmine, and it is severe:** *"The maximum limit is **20 refresh tokens per user**. If this limit is crossed, **the first refresh token is automatically deleted**… irrespective of whether the first refresh token is in use or not."*
>
> **For a practice that re-consents repeatedly, older connections silently break.** **Mitigation: issue one OAuth grant per Zoho *user*, then address each client ledger via the `organization_id` query param** — a single grant covers every org that user can access. **Do not issue one grant per client business.** This is the opposite of the per-org shape Xero uses, and it cuts against Neoting's `@@unique([businessId, kind])` `Integration` model in the same way Xero's user-keyed token store does (§1.1.5).

**Rate limits (verbatim from the Introduction page).** **100 requests/minute per organization** (429, error 44). Per-day, **by the client's plan**: Free 1,000 · Standard 2,000 · Professional 5,000 · Premium/Elite/Ultimate 10,000 (429, error 45). Concurrency: Free 5, Paid 10. **Because the buckets are per-org, multi-tenancy is not a bottleneck — but the ceiling is set by *each client's* subscription, not the practice's.**

⚠ **Documented contradiction:** the API docs quote a Free-plan quota of 1,000 calls/day, but the [UK pricing page](https://www.zoho.com/uk/books/pricing/) lists "API Access" as a **Standard-tier** feature. **Treat Free-plan API access as not verified and gate onboarding on a capability probe.**

##### ✅ D43 — attaching a file to a Bill: yes, and it is clean

`POST /bills/{bill_id}/attachment?organization_id={org}` — multipart, parameter name **`attachment`**. Returns 201. **Allowed extensions: `gif, png, jpeg, jpg, bmp, pdf`** — ⚠ **no TIFF and no HEIC**, so normalise on ingest. The bill object carries a `documents[]` array of `{document_id, file_name}`, **giving a clean reverse link from posted transaction back to source file** — better than QBO, which has no back-link (§1.2.6). **Max file size is not documented anywhere in the API reference — not verified;** determine empirically.

> 💷 **Decimal-money boundary.** `rate` and `adjustment` are typed **`double`** on the bill object ([Bills API](https://www.zoho.com/books/api/v3/bills/)). Convert integer pence → fixed-scale decimal on write, read the posted bill back, and assert `round(total × 100) == expected_pence`. **Zoho computes tax server-side, so you cannot assert totals pre-flight.**

**Sandbox: not verified** — the API reference documents no sandbox environment. The practical route is a free trial organisation per DC.

**Marketplace.** Publishing via a Marketplace Partner signup; review *"takes an average of two-to-three weeks"* covering code, performance, compliance and listing content, and **"We will never charge a fee for extension development"** ([Marketplace FAQ](https://www.zoho.com/marketplace/faq.html)). **No revenue-share percentage is published — not verified.** ⚠ Note the REST API needs **no marketplace approval**, so a listing is marketing surface rather than a technical gate.

**Costs (UK, per org/month, billed annually):** Free £0 · Standard £10 · Professional £20 · Premium £25 · Elite £85 · Ultimate £165. **AU:** Standard A$16.50 · Professional A$33.00.

**UK/AU relevance.** ⚠ **Zoho is on HMRC's MTD-for-VAT recognised list, flagged "suitable for businesses or agents", type "Record-keeping software"** ([HMRC finder](https://www.tax.service.gov.uk/making-tax-digital-software)) — a real practice-relevance signal. Zoho also runs an accountant partner programme and **Zoho Practice**, a practice-management console over many client orgs. AU edition supports GST and BAS report generation; **ATO/SBR lodgement status not verified.**

> **Verdict: Tier 2 — worth building, later.** Clean OAuth, per-transaction attachment with a genuine reverse link, a real practice console, HMRC-recognised. The costs are DC routing and the 20-refresh-token limit.

### 1.11 Odoo

**APIs.** Legacy **XML-RPC** (`/xmlrpc/2/common`, `/xmlrpc/2/object`) plus `/jsonrpc`; Odoo 19 introduces a **JSON-2 API** (`POST /json/2/<model>/<method>`, bearer API key).

> ⚠ **Two structural problems before you evaluate anything else.**
>
> **1. XML-RPC is pre-scheduled for removal.** The 19.0 docs state `/xmlrpc`, `/xmlrpc/2` and `/jsonrpc` are *"scheduled for removal in Odoo 22 (fall 2028)"* ([19.0 external API](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html)). **A rewrite is already on the calendar.**
>
> **2. No transactions across calls.** JSON-2 notes *"it is not possible to chain multiple calls inside a single transaction"* — **you cannot atomically create a bill, attach its PDF and post it.** You need idempotency keys and a repair path for partial states, which is precisely the failure mode D43 cannot tolerate.

> ⚠ **VERIFIED — external API is NOT available on all Odoo Online plans.** Verbatim in both 18.0 and 19.0 docs: *"Access to data via the external API is only available on Custom Odoo pricing plans. **Access to the external API is not available on One App Free or Standard plans.**"* Corroborated on [odoo.com/pricing](https://www.odoo.com/pricing) (One App Free $0 · Standard $7.25/user/mo · Custom $10.90/user/mo, yearly, USD).
>
> **This is a hard commercial gate: a practice's smaller clients are simply unreachable, and it is undetectable except by a failed call.** It inverts the long-tail economics that make a practice product work.

| | Odoo Online (SaaS) | Odoo.sh | Self-hosted |
|---|---|---|---|
| External API | **Custom plan only** | Yes | Yes |
| Custom modules | **No** | Yes | Yes |

**Auth.** API keys only — **no OAuth, no app-level consent, no "connect an org" flow.** Onboarding is N databases × N manually-created keys × N base URLs. ⚠ **Odoo 19 caps key validity at three months**, which is real rotation load across hundreds of ledgers. 2FA interaction: **not verified.**

**✅ D43 is satisfiable** via `ir.attachment` (`name`, `datas` base64, `res_model='account.move'`, `res_id`, `mimetype`) or `message_post()` with `attachment_ids` for a chatter audit trail. Size limits **not documented — not verified**.

**Vendor bill:** `account.move` with `move_type='in_invoice'`, then `action_post`. 💷 ⚠ **Odoo `Monetary`/`Float` fields are floats**; XML-RPC sends `<double>` and JSON-2 sends IEEE-754 binary64. `price_unit`, `amount_total`, `debit`, `credit`, `balance` all cross as binary floating point, and tax is computed server-side. **Read back and assert `round(amount_total × 100) == expected_pence`.**

**Rate limits: not documented** in either 18.0 or 19.0 docs. Assume silent SaaS throttling.

**Distribution.** App Store takes a **30% commission** ([apps.odoo.com/apps/upload](https://apps.odoo.com/apps/upload)) — but App Store modules don't run on Odoo Online, so it is not a channel for SaaS clients. Partner Programme tiers (US$390–1,950/yr) require *selling Odoo licences* — a poor fit for an ISV.

> **Honest relevance: marginal — deprioritise.** Odoo *is* on HMRC's MTD-VAT list, but flagged **"suitable for businesses"** — notably **not agents**, unlike every other candidate here. Its AU docs concede *"the BAS report is not directly submitted to the ATO"*. It is an ERP sold to SMB end users with **no practice-facing console**, the Custom-plan gate blocks the long tail, and a rewrite is pre-scheduled for 2028. **Rank below Xero, QBO, Sage and FreeAgent — and below Zoho Books.**

### 1.12 Other UK and AU platforms worth knowing about

| Platform | What it is | Public API? | Attach file to txn? | Money format | Verdict |
|---|---|---|---|---|---|
| **FreeAgent** | UK ledger (NatWest-owned) + Practice Dashboard | **Yes** — [dev.freeagent.com](https://dev.freeagent.com/docs/introduction), free registration, OAuth2 | **Yes** — base64, **5MB**, PNG/JPEG/GIF/PDF on bills, expenses, bank explanations | ✅ **String decimal** (`"total_value": "100.0"`) | **Tier 1** — see §1.5 |
| **Sage Business Cloud Accounting** | UK/AU cloud ledger | **Yes** — [v3.1 reference](https://developer.sage.com/accounting/apis/sagebusinesscloudaccounting/3.1.0/accounting), self-serve keys | **Yes** — [Attachments](https://developer.sage.com/accounting/apis/sagebusinesscloudaccounting/3.1.0/accounting/groups/attachments) | Decimal (typing not verified) | **Tier 1** — see §1.3 |
| **Clear Books** | UK cloud ledger | Docs public, **access on request** ([developers.clearbooks.co.uk](https://developers.clearbooks.co.uk/)) | **Yes** — `POST /accounting/purchases/{type}/{id}/attachments/{fileName}` | ⚠ `number <double>` in the OpenAPI spec | **Tier 2** |
| **QuickFile** | UK ledger, small base | Yes-ish — **MD5-hash auth, not OAuth**; 1,000 calls/day | not verified | not verified | Tier 3 |
| **KashFlow (IRIS)** | UK SMB ledger | ⚠ **SOAP only** (`.asmx`) | Yes — `AttachFileToInvoice/Receipt` | not verified | Defer |

> ✅ **Note the one genuinely good news item in this table: FreeAgent expresses money as a *string decimal*, not a float.** That is the only platform in this entire document that does so, and it eliminates the whole class of conversion risk flagged everywhere else. It should count in FreeAgent's favour when sequencing.

**Excluded — "not worth it, because…"** *(a short reason is more useful than silence)*

- **IRIS** — **no public API surface at all**; `developer.iris.co.uk` does not resolve and `api.elements.iris.co.uk` returns 403 with no published docs. The "Affinity Partner Program" is reseller/referral, not ISV. ⚠ **Treat as a BD conversation, not an engineering task** — but note IRIS is genuinely large in UK practices, so the conversation may be worth having.
- **CCH / Wolters Kluwer** — [developer.wolterskluwer.com](https://developer.wolterskluwer.com/) is login-gated with an empty anonymous catalogue. And **CCH Central/iFirm are practice-management layers, not the client ledgers Neoting posts into** — wrong layer entirely.
- **TaxCalc** — tax-return and accounts-production software. **No ledger, no API.** Practices feed it *from* Xero/QBO/FreeAgent.
- **Capium** — no published API (`api.capium.com` 404); negligible bookkeeping share.
- **Nomisma / "Nomi"** — no API, and its **WhatsApp receipt-capture + OCR feature makes it a competitor, not an integration target.** ⚠ Worth a look for competitive reasons: it is the closest UK analogue to Neoting's intake model.
- **BTCSoftware / Bright** — a *consumer* of bookkeeping data (its site advertises importing *from* Xero, Clear Books, FreeAgent, QuickBooks, Reckon). **Wrong side of the pipe.**
- **Pandle** — no public API despite good in-product receipt attachment.
- **Crunch** — Crunch is itself an accountancy practice selling to end clients; **integrating means integrating with a competitor's book of business.**
- **Sage 200** — partner-gated with no public reference; serves mid-market finance teams, not the many-small-clients workload. **Exclude for v1.**

> ⚠ **FreeAgent timing risk to plan around:** a **breaking change dated 1 December 2026** moves bank-transaction explanations to an array of up to 50 attachments via a new *Bank Transaction Explanation Attachments* endpoint; the singular `attachment` attribute stops being returned. **Build against the new endpoint from day one.**

**A note on MTD as a signal.** All UK candidates appear on HMRC's MTD-VAT list — but so do Pandle, Capium and Nomi, which have **no API**. **Treat MTD listing as a *relevance* signal, not an *API* signal.** The directional read matters for strategy: **MTD for Income Tax pushes more sole traders and landlords into quarterly digital record-keeping, multiplying the number of small client ledgers per practice** — which argues for *depth* on the few ledgers that can hold the source document over *breadth* across practice suites that hold no ledger at all.

### 1.13 The competitor benchmark — Dext, AutoEntry, Hubdoc

⚠ **These are competitors, not integration targets.** But their integration surface is the benchmark Neoting will be measured against, and **the finding here is the single most commercially useful item in this document.**

**Ledger coverage.** Dext publishes to Xero, QBO, QuickBooks Desktop, Sage 50 UK/CA, Sage Accounting, Sage Pastel, MYOB, KashFlow, FreeAgent, Twinfield, Zoho Books, Nomi, BrightBooks and Bill.com ([Dext Connect & Export](https://help.dext.com/en/collections/878041-connect-export)); desktop ledgers run through a **Windows-only bridge**. AutoEntry covers a similar list plus SortMyBooks, AccountsIQ, ClearBooks, ReckonOne and Exact. **Neither publishes to Sage 200.** Hubdoc still publishes to Xero, QBO **and** BILL — the widely-assumed QBO retirement **did not happen** (Xero helpdesk articles updated Sep 2025 still document both). Hubdoc is free on all Xero business plans and is being absorbed into Xero "Smart Document capture".

#### ⚠ The D43 answer — and it is the strategic opening

**No competitor achieves universal source-document attachment.**

| Ledger | Dext | AutoEntry | Hubdoc |
|---|---|---|---|
| **Xero** | Yes | not verified | **Yes** — *"with the original bill or receipt attached"* ([listing](https://apps.xero.com/uk/app/hubdoc)) |
| **QuickBooks Online** | Yes; also attaches an approval-history PDF | not verified | **Yes, conditional** — under 25MB attaches; **over 25MB becomes a link** ([Hubdoc](https://support.hubdoc.com/hc/en-us/articles/115003479663-About-publishing-documents-to-QuickBooks-Online)) |
| **Sage Accounting** | ⚠ **Link only** — *"Because Quick Entries don't support file attachments in Sage Accounting, Dext adds a link"* ([603424](https://help.dext.com/en/articles/603424-how-to-publish-items-to-sage-accounting-from-dext)) | ✅ **Yes** — a real attachment ([1692778](https://help.autoentry.com/en/articles/1692778-find-invoice-image-in-sage-accounting)) | n/a |
| **Sage 50 UK** | ⚠ **No** — *"Dext cannot send PDF attachments to Sage 50 directly"* ([629743](https://help.dext.com/en/articles/629743-how-to-publish-to-sage-50-uk)) | ⚠ **No** — shared link only | n/a |
| **MYOB** | not verified | ⚠ **No** — *"invoice image posting… not available"* ([1748400](https://help.autoentry.com/en/articles/1748400-myob-and-autoentry-features)) | n/a |
| **FreeAgent** | Partial — images sent alongside expense claims only | not verified | n/a |

> **The honest benchmark: Xero and QBO are solved by everyone. Sage 50, Sage Accounting Quick Entries, MYOB and FreeAgent are where the incumbents fall back to a hyperlink — which does not satisfy D43.**
>
> **This is Neoting's opening, and it is a real one.** §1.6.6 establishes that **MYOB *does* support real bill attachments** via `/Purchase/Bill/{layout}/{UID}/Attachment` — and AutoEntry's own help page says it does not post invoice images to MYOB. **A competitor's documented gap is not always a platform limitation.** Likewise AutoEntry attaches properly to Sage Accounting where Dext posts a link, which means the Sage limitation is a *Quick Entries* limitation, not a Sage Accounting one — i.e. it is a choice of entity, not a wall. **Both are worth verifying and, if they hold, worth saying out loud in the product's positioning.** It is exactly the same instinct that made D43's rung-4 manifest a differentiator rather than a fallback.

**How it is done technically — and it needs no partner status.** Xero: raw bytes to `POST /Invoices/{Guid}/Attachments/{FileName}`; **10 attachments per document, each up to 10MB** — ⚠ note this is **10MB, not the commonly-cited 25MB**. Gated only by the ordinary `accounting.attachments` scope, **available on the free Starter tier**. QBO: `POST /upload` multipart with paired metadata/content parts; **100MB per request**, transaction must already exist, and ⚠ **no back-link from the object to the attachment** (reverse lookup requires querying `attachable` by `AttachableRef` — *exactly what D43's audit trail needs, and it should be tested explicitly*).

> ✅ **The conclusion that should shape the plan: neither Xero nor QBO requires partner status to use its attachments API. Certification is a distribution requirement, not a technical one — so D43 through an API is buildable before any commercial relationship exists.**

### 1.14 Unified-API aggregators — the "one integration" shortcut, and why it is not one

> **⚠ Direct answer to the strategic question: an aggregator REMOVES nothing and DEFERS nothing on the certification front. It is a code-reuse convenience, not a shortcut past the queues in this document.**
>
> This is the most commonly-held wrong belief about this space, and getting it wrong would cost months. **Every serious aggregator uses a bring-your-own-credentials model for Xero and QuickBooks Online: *you* register the developer app, *you* supply the client ID and secret, *your* app carries the connection limits, and *you* go through Xero App Partner certification and Intuit's security assessment. The aggregator is only the redirect target.**

#### 1.14.1 The evidence, per vendor

| Vendor | Xero | QuickBooks Online |
|---|---|---|
| **Codat** | Your app; redirect `https://xero.codat.io/oauth2/callback`. *"you can connect up to 5 companies. If you want to connect more than 5 companies, you'll need to register as a Xero App Partner"* ([setup](https://docs.codat.io/integrations/accounting/xero/accounting-xero-setup); [app partner](https://docs.codat.io/integrations/accounting/xero/xero-app-partner-program) — which Codat says *"can take several months"*) | Your Intuit app; you must "complete the *App Assessment Questionnaire* provided by Intuit" for production keys ([setup](https://docs.codat.io/integrations/accounting/quickbooksonline/accounting-quickbooksonline-new-setup)) |
| **Rutter** | *"Rutter utilizes your platform's developer account credentials"* — a developer app is **required** for Xero, QBO, Sage Business Cloud, Exact, Zoho, D365, FreeAgent, FreshBooks ([requirements table](https://docs.rutter.com/platforms/developer-app-requirements)). ⚠ Pulling bills for payment lands you in Xero's **Financial Services** review queue, which "commonly takes several months" and **cannot be expedited** ([Xero guide](https://docs.rutter.com/platforms/accounting/xero)) | Your app ([same table](https://docs.rutter.com/platforms/developer-app-requirements)) |
| **Merge** | *"you will need to set up a Xero App and enter your applications credentials within Merge."* Review needs "ten active customer connections within a 30-day period" ([docs](https://help.merge.dev/en/articles/6802115-xero-how-do-i-set-up-my-partner-credentials)) | *"you will need to set up a QuickBooks Online App, get approved by Intuit"* ([docs](https://help.merge.dev/en/articles/9833261-quickbooks-online-how-do-i-set-up-partner-credentials)) |
| **Apideck** | Your app; redirect `https://unify.apideck.com/vault/callback` ([docs](https://developers.apideck.com/connectors/xero/docs/application_owner+oauth_credentials.md)) | *"If your app has any connections to production QuickBooks Online companies, you will need to submit this questionnaire **even if your app is not listed on the QuickBooks App Store**"* ([docs](https://developers.apideck.com/connectors/quickbooks/docs/application_owner+oauth_credentials.md)) |

**No vendor documents a white-label "use our app" option for Xero or QBO.**

> **A useful cross-check on §1.1.4.** Codat's documentation says the uncertified Xero cap is **5 companies**; Merge's says **25 Xero accounts**. Codat's figure matches the current Xero tier table verified in §1.1.4; **Merge's page is stale in exactly the same way three of Xero's own pages are.** Two independent aggregators disagreeing is itself evidence of how recently this changed — and it means **you cannot trust an aggregator's documentation for a platform limit.** Go to the platform.

Two further consequences land on you regardless of vendor: Xero moved to tiered usage pricing on **2 March 2026** ([Codat changelog](https://docs.codat.io/updates/260116-xero-pricing)), and Intuit's App Partner Program variable API fees began **1 November 2025** ([changelog](https://docs.codat.io/updates/250603-intuit-partner-program-changes)).

#### 1.14.2 What you actually buy

Not a bypass — **normalisation across ledgers, connector maintenance, a hosted consent UI, and token management**. For Neoting specifically, "token management" is not nothing: §4.2 identifies the token vault and refresh scheduler as the largest missing pieces, and an aggregator supplies both. That is a real, honest reason to consider one. But **budget the Xero App Partner journey and the Intuit assessment as unavoidable, and start them early, in parallel with any aggregator evaluation.**

#### 1.14.3 Comparison

| | **Codat** | **Rutter** | **Apideck** | **Merge** |
|---|---|---|---|---|
| **UK depth** | **Best**: Xero, QBO, Sage Accounting, **Sage 50 (on-prem)**, Sage 200, Intacct, **FreeAgent**, FreshBooks | Xero, QBO, Sage BC, Sage 50, Sage 200 Cloud, Intacct, FreeAgent, FreshBooks | Xero, QBO, Sage BC, Intacct, FreeAgent (read-only bills), FreshBooks | **Weakest: no Sage 50** |
| **AU** | **MYOB ✅**; Reckon **deprecated 31 Oct 2025** ([changelog](https://docs.codat.io/updates/251003-deprecation-of-integrations)) | No MYOB in createBill; no Reckon | **MYOB ✅** (full CRUD bills) | **No MYOB, no Reckon** |
| **Create bills** | `POST …/push/bills`; Bill Pay `create-bill` limited to FreeAgent, NetSuite, QBO, Intacct, Xero, Zoho ([Bill Pay](https://docs.codat.io/payables/overview)). Async + webhook ([push](https://docs.codat.io/using-the-api/push)) | `POST /accounting/bills` — 22 platforms; **Sage 50 and Sage 200 excluded** | `POST /accounting/bills` — **41 of 48 connectors** ([coverage](https://developers.apideck.com/apis/accounting/coverage/bills)) | No Bill model — `POST /accounting/v1/invoices` with `type: ACCOUNTS_PAYABLE` ([docs](https://docs.merge.dev/merge-unified/accounting/common-models/invoices/create.md)) |
| **⚠ Attach file to the bill (D43)** | ✅ record-scoped `POST …/bills/{billId}/attachments`; size limits published only in the [OpenAPI spec](https://github.com/codatio/oas/blob/main/yaml/Codat-Sync-Payables.yaml) (Xero 4 MB, QBO 100 MB, NetSuite 100 MB, D365BC 350 MB). **Per-platform support matrix is not published** | ✅ `POST /accounting/bills/{id}/attachments` — Xero ✅, QBO ✅, Zoho ✅; **FreeAgent ❌, FreshBooks ❌, MYOB ❌, Sage BC ❌, Sage 50 ❌, QBD ❌** | ✅ record-scoped `POST /accounting/attachments/{reference_type}/{reference_id}` — but only **21 of 48** connectors; **no attachment support for MYOB, FreeAgent, FreshBooks, Zoho, Exact** ([coverage](https://developers.apideck.com/apis/accounting/coverage/attachments)) | ⚠️ `POST /accounting/v1/attachments` exists, but the object's **only association is `company`** — **no documented field links an attachment to a bill** ([object](https://docs.merge.dev/merge-unified/accounting/common-models/attachments/list.md)) |
| **Tenancy model** | `company` (client business) → 1..n `connection`; writes scoped `{companyId}/{connectionId}` — **cleanest practice→clients fit** | Connections only, no company object; you model the hierarchy | Consumers → Connections; billed per active consumer | Linked Account per `end_user_origin_id` per category |
| **Pricing** | Sales-only, no public page | Sales-only; free 30-day sandbox ([pricing](https://www.rutter.com/pricing)) | **Published**: Launch €599/mo (25 consumers), Scale €1,299/mo (100 consumers) ([pricing](https://www.apideck.com/pricing)) | **Published**: 3 free, then $650/mo to 10 accounts, **$65 each after** ([pricing](https://www.merge.dev/pricing)) |
| **Rate limits** | 1,000 × (1 + active connected companies)/day; 10 concurrent per company ([docs](https://docs.codat.io/using-the-api/rate-limits)) | 500 req/10s per org ([docs](https://docs.rutter.com/rest/2024-08-31/basics)) | **not verified** | 100–600/min per Linked Account by tier ([docs](https://docs.merge.dev/merge-unified/hris/merge-api-basics/rate-limits.md)) |

**Railz is dead as an option.** `railz.ai` now 301-redirects to **[FIS Accounting Data as a Service](https://www.fisglobal.com/products/accounting-data-as-a-service)**, "formerly Railz". Acquirer **FIS**; acquisition date **not verified**. Positioning is read/analytics — no bill-create or attachment-write found. **Drop it.**

Of other names checked: **Kombo** has no accounting category (HRIS/ATS/payroll only). **Chift** is EU-focused (Odoo, Pennylane); UK depth and AU coverage **not verified**. Fintecture, Paragon, Nango, Integration.app, Vessel, Truto, Finrise, Akoya and Plaid — no confirmed normalised accounting-ledger **write** model; **not verified**, and should not be treated as contenders without checking.

#### 1.14.4 Recommendation

> ⚠ **The pricing gap is an order of magnitude, and it is decided by Neoting's per-ledger economics.** Neoting charges **£8.50/month per client business** (D48). At ~200 client ledgers, Merge's published price is roughly **$13,000/month** against Apideck Scale at **€1,299/month per 100 consumers**. **Merge's per-account pricing exceeds Neoting's entire per-client revenue several times over and is structurally incompatible with the product's price point.** Any aggregator must be checked against the £8.50 line before anything else — a per-connection fee is a direct subtraction from a very thin per-client margin.

**Shortlist Codat and Apideck.**

- **Codat** is the only vendor covering **Sage 50 + FreeAgent (UK) + MYOB (AU)** with bill-create and bill-scoped attachments, and its `company` → `connection` model maps directly onto practice → clients, which matches Neoting's `Integration.businessId` shape. ⚠ But **get written confirmation of attachment support on FreeAgent, Sage 50 / Sage Accounting and MYOB before committing**, because Codat publishes no per-platform attachment matrix and D43 depends on it.
- **Apideck** has the broadest published bill coverage, genuinely record-scoped attachments, transparent per-connector matrices, and the cheapest per-ledger pricing. ⚠ But **its attachment coverage excludes MYOB**, which is the Australian market.

**Rule out Merge** on this requirement set: no Sage 50, no MYOB, an Attachments model with **no documented link to the bill it evidences** — which breaks D43 outright unless disproved via `/attachments/meta/post` — and pricing incompatible with £8.50/client.

> ⚠ **The sharpest risk across the whole aggregator option is Australia. MYOB bill attachments are explicitly unsupported on Rutter and Apideck, and unverified on Codat.** Resolve that before treating Australia as an aggregator-served market — otherwise the AU launch silently ships without D43.


### 1.15 VT Transaction+ — today's export target

> **Verdict: VT Transaction+ has no API of any kind. File and clipboard import is the only route. Design for it; never put a VT API on a critical path, because there is nothing to wait for.**

#### 1.15.1 Evidence of absence

This is a negative claim, so it is evidenced by an inventory of the whole of vtsoftware.co.uk from the homepage link graph. There is **no developer section, no API page, no SDK, no ODBC or COM documentation, no partner or integration programme, and no developers subdomain.**

| Source | What it contains | What it does not |
|---|---|---|
| [Homepage nav + link inventory](https://www.vtsoftware.co.uk/) | Home, Support, Prices, Customer Comments, MTD for Income Tax, MTD for VAT, User Guides, Video Guides, FAQs, Blog | Any developer, API, integration or partner link |
| [Support page](https://www.vtsoftware.co.uk/support/index.htm) | Phone 020 8995 1142, support@vtsoftware.co.uk, 9–5 Mon–Fri, subscribers only | No developer support channel |
| [FAQs](https://www.vtsoftware.co.uk/faqs.htm) — 34 questions | Q2 and Q33: *"VT's products are desktop applications and are not cloud based"* | Not one question about APIs, integrations, attachments or receipts |
| [Feature list](https://www.vtsoftware.co.uk/tranplus/features.htm) | "Universal Input Sheet for copying and pasting or importing transactions from other systems"; "Automatic import of trial balance from other accounts packages" | No API, no attachments, no document storage |
| [Published roadmap](https://www.vtsoftware.co.uk/blog/development.htm) | MTD for Income Tax quarterly updates (April 2026); micro-entity accounts for mandatory Companies House e-filing (April 2027) | Zero mention of API, cloud, integrations or partner programme |

> **The decisive evidence is VT's own commercial integrations.** VT integrates with seven tax packages (Absolute Integrated, Absolute TopUp, BTC SA Solution, Forbes Pro Tax, Ablegatio Ftax, QMS SA2000, TaxCalc) — and the mechanism is **the Windows clipboard**: *"Data is sent via the Clipboard (like copy and paste) in an agreed format called Standard Name Format (SNF)"* ([tax packages](https://www.vtsoftware.co.uk/tax_packages/index.htm)). **A vendor with an API would not run its own paid partner integrations over the clipboard.** Customer/supplier export is likewise clipboard-only — `Edit > Copy Account Names and Addresses` ([docs](https://www.vtsoftware.co.uk/transplushelp/exporting-customer-and-supplie.html)).

The data model reinforces it: one proprietary file per company on local disk, with the help recommending you email or copy the file between PCs. An *undocumented* COM/automation interface inside the binary is **not verified** — but nothing public offers one and nothing would be supported.

#### 1.15.2 Import routes — corroborating the internal finding, with one correction

| Surface | Menu path | Formats | Status |
|---|---|---|---|
| **Journal** | `Transaction > Journal > Import`, or the arrow beside the JRN toolbar button | Clipboard, CSV, tab-delimited. Col A account name, B entry details, C debit, D credit | **Corroborated** ([docs](https://www.vtsoftware.co.uk/transplushelp/importing-a-journal.html)) |
| Reversing journal | Not stated in help | "a reversing journal can be entered using the classic style, trial balance style or import dialogs" | **Corroborated** that an import dialog exists ([docs](https://www.vtsoftware.co.uk/transplushelp/reversing_journals.html)); exact path **not verified** |
| Trial balance | `Edit > Import Trial Balance` | Clipboard, CSV, text; TB Converter with Sage presets | **Corroborated** ([docs](https://www.vtsoftware.co.uk/transplushelp/importing-a-trial-balance.html)) |
| Ledger / account names | — | — | **Not verified publicly.** Help documents only manual creation and clipboard *export* |
| **Universal Input Sheet (transactions)** | `Transactions > Universal Input Sheet` → "Import from: CSV File / Text File / Clipboard" | General options / Bank statement options; per-column mapping; header-row option | **Corroborated, and it is a fifth surface** ([docs](https://www.vtsoftware.co.uk/transplushelp/importing.html)) |

> ⚠ **Correction to the internal research recorded in SoT §24.3.1.** The internal finding of *"exactly four import surfaces"* understates it, and the finding that the Universal Input Sheet *"has no import command of any kind"* is **contradicted by VT's own published help**, which documents `Import from: CSV File / Text File / Clipboard` on the UIS with per-column mapping. The UIS import is a functionally distinct fifth route, and it is the one that posts **real transaction types** (PIN, PAY, REC…) rather than journals.
>
> **This does not overturn the D42/D43 decision, and the journal route the product already builds against remains valid** — but it is a discrepancy between the repository's record and the vendor's documentation, and it should be resolved on the licensed install rather than left standing. It is possible the installed version differs, or that the dialog is reached differently than expected. **Flagging it, not resolving it.**

**Two constraints with direct product consequences:**

1. ⚠ **Split analysis cannot be imported through the UIS.** *"If a single transaction has more than one analysis account, i.e. a split analysis, it cannot be imported"* ([docs](https://www.vtsoftware.co.uk/transplushelp/importing.html)). **A multi-line purchase invoice — the normal case for Neoting — cannot go through the UIS import.** It must go via journal import, or be pasted directly onto the sheet. This corroborates the constraint already recorded in the `exports-public-api` module notes ("VT's import accepts one nominal per row") and independently justifies the journal route the product chose.
2. **"Preview Journal" is not corroborated publicly.** Neither [journals.html](https://www.vtsoftware.co.uk/transplushelp/journals.html) nor the journal import topic mentions a preview or dry run — **not verified** from public sources, though the internal test on a licensed install observed it. The UIS gives a *de facto* dry run regardless: imported rows land on an editable sheet and nothing commits until **Post**.

A **Converter** exists on both the journal and UIS paths, with `Sage to VTT+` and `Custom names` conversion tables and an `Auto Assign` button — corroborating the internal finding.

#### 1.15.3 ✅ Attachments: confirmed — VT cannot attach files to transactions

**The internal finding is confirmed from public sources.** The complete transaction type list is PAY, CHQ, REC, P+R, TRF, SIN, SCR, PIN, PCR, CTX, JRN, RJN ([entry methods](https://www.vtsoftware.co.uk/transplushelp/transaction_entry_methods.html)). The purchase-invoice dialog's fields are Date, Supplier's invoice number/details, Total, Input VAT, Net, Invoice date, then per line Amount, Analysis Ledger, Analysis Account, Entry details ([docs](https://www.vtsoftware.co.uk/transplushelp/enter-a-purchase-invoice.html)). The UIS format is Type, Ref no, Date, Primary account, Details, Total, VAT, Analysis account, Analysis, Entry details ([docs](https://www.vtsoftware.co.uk/transplushelp/data-format-of-the-uis.html)).

**No file, scan, image, PDF or document field appears anywhere** — not in the dialogs, not in the import format, not in the feature list, not in the help contents, not in the FAQ.

> **D43 consequence, stated plainly.** D43 **cannot be satisfied inside VT**. The only carriers are text: transaction-level **Details**, line-level **Entry details**, and **Ref no**. The product's existing design — mint a short stable document token, write it into the entry-details field on every posted line, and hold the document and the mapping in Neoting — is the correct and only answer. **D43 is therefore satisfied by Neoting, not by VT.** That is worth recording explicitly rather than leaving implied, because it is the one export target where the requirement is met by the product rather than by the ledger.

**Hyperlink rendering: still not verified.** No public source states whether VT renders a URL in a text field as clickable. The internal working assumption that it does not remains the safe one. **Field length limits for Details and Entry details are also undocumented publicly — not verified**, though the internal test measured 104 characters importing untruncated in `Paid to/invoice details`. A truncated token breaks traceability, so that measurement is load-bearing and worth re-confirming on each VT version the client runs.

#### 1.15.4 💷 Decimal-money boundary

**Every VT import format is decimal text.** Journal import takes debit/credit as decimals; the UIS takes Total/VAT/Analysis as positive decimals with the sign inferred from the type column, while journal rows use debits positive and credits negative. Neoting's integer pence must be converted at the exporter boundary — which `exports-public-api/canonical/money.ts` already does correctly, by integer division and string concatenation rather than `pence / 100`.

Two further hazards worth naming:

- ⚠ **The export must be UK-locale** — decimal point, not comma — or the CSV parses wrongly and silently.
- ⚠ **The UIS uses colon syntax** for `Ledger: Account` and `Account: Department`, so **any account name containing a colon is a parsing hazard**. This is a real risk given VT's own analysis accounts are written `Cost of sales: Purchases`.

#### 1.15.5 Company, pricing, viability, and who to talk to

**Actively developed, but on a compliance-only track.** The homepage installer is `VTInstaller-2026-08-25.exe` and the latest blog post is dated 25 August 2026 — so the product is alive. But the published roadmap contains only MTD for Income Tax (April 2026) and Companies House e-filing (April 2027). **There is no cloud product and none is planned.**

Pricing ([prices](https://www.vtsoftware.co.uk/prices/index.htm)): VT Transaction+ **£90+VAT/year per named user**; VT Accounts Suite £175+VAT/year; VT Cash Book free; **unlimited clients per licence**.

VT Software Limited, company no. **02598775**, incorporated 8 April 1991, registered office Gable House, 18–24 Turnham Green Terrace, London W4 1QP; VAT GB 538774989; director/owner Philip Hodgson; *"committed to remaining an independent company"* ([about](https://www.vtsoftware.co.uk/about.htm)). Companies House shows **active**, filing unaudited abridged small-company accounts ([filing history](https://find-and-update.company-information.service.gov.uk/company/02598775/filing-history)).

> **Who to approach: effectively nobody.** There is no BD or partner function — only `info@vtsoftware.co.uk`, `020 8995 1142`, or the owner-director. **Set expectations low.** A micro-vendor that runs its own commercial integrations over the clipboard, states an independence policy, and has a purely regulatory roadmap is not going to build an API for you. **Do not spend time lobbying for one.** The file export is not a stopgap pending a better VT route; it is the permanent answer for VT.

**Market position.** VT's own claim is that ICAEW surveys found it "one of the leading accounts production package vendors", with the 2011 survey rating VT products "best performing" — vendor-sourced and now fifteen years old. **Independent current market-share data is not verified.** What is verifiable is that VT's [customer comments page](https://www.vtsoftware.co.uk/comments_review_survey/customercomments.htm) consists largely of links to AccountingWEB threads, indicating a durable grassroots following. Strategically, **£90/year desktop software clusters in small and sole-practitioner compliance practices — precisely the segment doing high-volume manual keying**, which is Neoting's ideal customer. That is an argument for VT mattering more than its brand profile suggests, but sizing it needs primary research.


## 2. A recommended sequence for this product

### 2.1 The recommendation in one line

> **Build the shared OAuth + token-vault layer against Sage Business Cloud Accounting or FreeAgent, but ship Xero first.**

Those are two different statements and both matter. **Xero is the right first platform to *ship*, because it is where the customers are and because one integration serves both the UK and Australia.** But **Xero is a poor platform to *learn on*** — its uncertified 5-connection cap, its rotating tokens with a 30-minute grace window, its user-keyed token store and its 98 float-typed money fields make it the least forgiving place to discover that your shared infrastructure is wrong. Sage Accounting and FreeAgent are far gentler, and the layer you build is the same layer.

### 2.2 Why Xero is the first platform to ship

| Reason | Evidence |
|---|---|
| **It is the AU market *and* a large share of the UK market — one integration, two countries.** Xero ANZ alone reports **2.8 million customers** (FY26). **Xero AU and Xero UK are the same API with the same app registration.** | §1.9.1 |
| **A UK-first, Australia-second product gets its second market nearly free.** No new programme, no new fee, no new residency negotiation — unlike MYOB, which needs all three | §1.1, §1.6 |
| **D43 is not merely satisfiable, it is best-in-class.** Xero is the only platform offering **both** a real file attachment **and** a clickable `Url` deep link back to the source record. That is rungs 1 and 4 of D43's ladder simultaneously | §1.1.6 |
| **It is free to start and free to pilot.** 5 connections at £0; 50 for the price of putting a card on file. **No review, no questionnaire, no certification to write into a real client's ledger** | §1.1.4 |
| **The repository has already committed to it.** `ledger-adapter.ts`: *"Xero SDK + OAuth is the committed real implementation; this interface is the seam it drops in behind."* `DemoXeroAdapter` exists. `IntegrationKind` already holds `XERO` | §4.1 |
| **Revenue share is gone.** Xero retired the 15%-of-ARPU model; **you keep 100% of your £8.50** and pay a flat platform fee instead | §1.1.3 |

**The three things that argue against Xero, and why they do not change the answer:**

1. ⚠ **The 5-connection cap.** Real, and it is the tightest gate in this document. **But it does not bind:** adding a payment method lifts it to 50 immediately, and 50 client organisations is a genuine pilot across several practices. Certification for 1,000 can follow at leisure.
2. ⚠ **"Each organisation is limited to two uncertified apps."** This one *can* bite invisibly — a client already running Dext and one other tool cannot connect a third uncertified app. **Ask pilot practices to check before you promise anything.** It is also an argument for reaching certification sooner than the connection count alone would suggest.
3. ⚠ **Bulk Connections is gated at Advanced (A$1,445/mo + certification + security assessment + use-case approval).** Without it, a 200-client practice needs 200 consent journeys. **This is the real long pole**, and it is why the Developer Evangelist conversation should start early rather than at scale.

### 2.3 The full sequence, with reasoning

| # | Platform | When | Why here |
|---|---|---|---|
| **0** | **None — the shared layer** | **Before any application** | OAuth authorization-code flow, the token vault, the refresh scheduler, the per-org connection UI, and COA/tax-rate sync into `ReferenceSync`. **All five are platform-agnostic and all five are missing today (§4.2).** Build against a *sandbox* — FreeAgent's is free and self-serve, Sage gives you a 12-month developer business. **This is the work; everything after it is an adapter.** |
| **1** | **Xero** | First to ship | §2.2. Register the app on day one — it is free, and the 5 connections cover the pilot while you build |
| **2** | **QuickBooks Online** | Close second | The #2 UK platform and a real AU presence. ⚠ **No connection cap once the questionnaire clears** — so it scales *further* than Xero without certification. But **reads are metered and this pipeline is read-heavy**, so it needs the caching discipline of §1.2.9 designed in, not retrofitted. **Build Intuit SSO from the start** even though private production does not need it |
| **3** | **Sage Business Cloud Accounting** | Third | ⚠ **Arguably the best *mechanics* of any platform here** — no connection cap, **Partner Edition gives one grant for every client a practice manages**, 7-day idempotency, free. And **§1.13 shows Dext falls back to a link on Sage Accounting while the API supports real attachments** — a documented competitor gap Neoting can beat. Placed third only because Xero and QBO have more UK practice share |
| **4** | **FreeAgent** | Fourth, and cheap | ✅ **Fastest to build (4–7 weeks), free, real sandbox, per-client rate limits, and the only platform where money is a string not a float.** Its market share understates its reach because **NatWest/RBS/Mettle customers get it free**. A genuinely low-cost win |
| **5** | **MYOB Business + AccountRight** | **The Australian launch** | The only genuinely *new* work for the AU market. ⚠ Start the **residency decision and the clause 1(d)/clause 34 conversations 3+ months ahead** — they, not the API, are the critical path |
| **6** | **Reckon One** | Optional, cheap | Free, well-documented OpenAPI, 5–9 weeks. Small but real. Take it if AU traction justifies it |
| **7** | **Zoho Books** | Opportunistic | Clean API, HMRC-recognised, a real practice console. Take it if customers ask |
| **—** | **Sage 50 (UK)** | ⚠ **Do not build** | ~£2,500/yr, **5–9 months**, a Windows agent per client site, a stored password per company, and **D43 cannot be satisfied.** See §2.4 |
| **—** | **Odoo** | Deprioritise | External API is **Custom-plan-only**, no practice console, XML-RPC removal scheduled for 2028 |
| **—** | **VT Transaction+** | ❌ **Nothing to apply for** | No API exists. **The file export is the permanent answer, not a stopgap.** Do not spend time lobbying VT |

### 2.4 The Sage 50 decision, stated plainly

Sage 50 has real weight among exactly the small UK practices Neoting targets — which is why it is tempting. **Decline it anyway, for now**, on four grounds that compound:

1. **D43 is unachievable.** §1.4.6 — and the proof is that **AutoEntry, which Sage owns and which has unrestricted SDO access, still posts a link rather than the file.** Shipping Sage 50 means shipping a product whose central traceability promise is weaker there than anywhere else.
2. **It is a different company.** A Windows agent installed at each client site, kept online, auto-updating, rebuilt every annual Sage release, with a support load dominated by other people's networks. That is a second product, not an adapter.
3. **The credential model is the worst here** — a stored Sage username and password per client company, with no rotation and no scope.
4. ⚠ **Sage may be about to obsolete the route.** The undocumented **"Use third-party applications"** login type appearing in v31.1+ alongside Sage Copilot (§1.4.4) suggests a cloud path is coming. **Spending £2,500 and six months on a COM agent immediately before that lands would be the single most expensive mistake available in this document.**

**Instead:** ask `isvdeveloperuk@sage.com` directly what that login type is and when a Sage 50 cloud path arrives. And note the escape hatch — **Sage runs a first-party Sage 50 → Sage Accounting migration at a target of 3 working days per dataset.** Helping a practice move its clients onto Sage Accounting may serve both parties better than building an agent, and it lands them on a platform where D43 works.

### 2.5 On aggregators — decide this before step 1, not after

§1.14 establishes that **an aggregator does not remove or defer a single certification gate**: you still register your own Xero and Intuit apps, your app still carries the connection limits, and you still face Xero certification and Intuit's questionnaire. What an aggregator *does* supply is precisely the shared layer of step 0 — token management, a hosted consent UI, and connector maintenance.

**So the question is narrow and answerable:** is buying step 0 worth more than building it? Two constraints decide it:

- ⚠ **Price against £8.50/client/month (D48).** Merge's published pricing works out at roughly **$13,000/month at 200 client ledgers** — **several times Neoting's entire gross revenue from those clients.** Apideck's Scale tier at €1,299/100 consumers is the only published pricing in the same universe. **Any per-connection fee is a direct subtraction from a very thin margin.**
- ⚠ **D43 must survive the abstraction.** Merge has **no documented link between an attachment and the bill it evidences** — that breaks D43 outright. Apideck excludes MYOB from attachments; Rutter excludes MYOB, Sage and FreeAgent. **Codat is the only shortlist candidate covering Sage 50 + FreeAgent + MYOB with bill-scoped attachments — and it publishes no per-platform matrix, so get it in writing.**

**Recommendation: build step 0 in-house.** The layer is bounded, it is reusable across all seven platforms, it is the thing security questionnaires interrogate (so you want to be able to describe it precisely), and no aggregator's pricing model fits £8.50 per client. Revisit only if the platform count grows past four and the maintenance burden becomes the constraint.

### 2.6 What to do in the first two weeks — concrete

**None of these require a line of application code, and several run on someone else's clock:**

1. **Obtain the VAT registration number and complete Stripe company verification** (§3.1). It is one errand and it unblocks Stripe live mode, the legal pack, and the company section of every application here.
2. **Register a free Xero developer app** and enable a UK demo company. Free, instant, and the 5 connections cover the whole pilot.
3. **Create an Intuit developer account and a UK-region sandbox** — ⚠ **create the UK sandbox first; region cannot be changed after creation.**
4. **Sign up for Sage and FreeAgent developer accounts, and email `integrationsrequests@freeagent.com`** for a sandbox Practice Dashboard. Both free; the FreeAgent email has a lead time.
5. **Send three questions to MYOB** (`apisupport`): will you admit a UK-domiciled applicant; what is your position on UK/EU hosting; and does clause 34 prohibit an internal-only tool layer? **All three have long answer times and all three could change the AU plan.**
6. **Audit the pipeline against the AI clauses.** Both Xero and MYOB **prohibit training on API-derived data**, and MYOB additionally requires your LLM vendor to be **contractually barred from training on it**. Get the zero-retention paperwork now.
7. **Ask two pilot practices to check how many uncertified apps their clients' Xero organisations already have** — the limit is two, and it is invisible until it blocks you.

## 3. Readiness checklist — what the company needs before applying

> **The single most useful idea in this document.** Almost every item below is demanded by **more than one** of these programmes, *and* by Stripe, *and* by the legal pack. They are not separate chores. **Obtain each artefact once and it unblocks several things simultaneously.** The corollary is the uncomfortable one: the items that are missing today are missing for *everything* at once, and each one blocks a queue rather than a single task.

### 3.1 ⚠ The two known blockers, and why they are the same blocker

Both of these are already documented in the repository as live blockers on a *different* workstream. Every developer programme in §1 will demand the same evidence.

| # | Blocker | Where it is recorded | What it currently blocks | What it will *additionally* block |
|---|---|---|---|---|
| **B1** | **The UK VAT registration number is still a `[PLACEHOLDER]`.** The nine-digit `GB…` reference is not held. ⚠ `9286810564` is the company **tax ID** and is **not** the VAT registration number — confirmed 26 Aug 2026. | `docs/legal/privacy-notice.md` line 91, `docs/legal/refund-and-cancellation.md` line 164, `docs/legal/README.md` §1 | The privacy notice and refund policy cannot be published. A VAT invoice carrying the wrong registration number **is not a valid VAT invoice**. | Any developer-programme application that asks for VAT registration; any partner agreement that is a commercial contract with a UK entity; any marketplace listing with a paid plan. |
| **B2** | **Stripe live mode is blocked on company verification *plus* that same VAT number.** | `docs/runbooks/stripe-billing.md` §0 and §1 — prerequisites 2 and 3 | Live-mode billing entirely. The Stripe CLI is currently signed in to a **personal** account (`acct_1RQtbx…`) holding unrelated products; live mode needs the Neoting company account, "because that is the account the company verification, the UK VAT registration number and the bank payout details attach to." | Nothing extra — but it shares B1's root cause, and company/director verification produces exactly the identity evidence the developer programmes ask for. |

> **Say it plainly: B1 and B2 are one errand.** Obtaining the VAT registration certificate and completing company/director verification produces, in one pass, the evidence needed for Stripe live mode, for publishing the legal pack, and for the company-details section of every developer-programme application in §1. It is the highest-leverage single action available, and it is a form-filling exercise, not an engineering one. Do it first, and do it before any of the build work in §4, because it runs on someone else's clock.
>
> **A third item shares the same character:** `docs/legal/privacy-notice.md` line 92 records the **ICO data protection fee registration number** as a `[PLACEHOLDER]` too. A UK controller processing personal data almost certainly must be registered with the Information Commissioner's Office and pay the annual data protection fee. It is cheap, it is quick, and its absence is conspicuous to anyone reviewing a UK data-handling application.

### 3.2 Corporate identity

- [ ] **Registered company details confirmed.** SoT D34 records company number **16261850** for **Exam Binary Ltd** — `docs/legal/privacy-notice.md` line 88 still marks it "confirm". Confirm it against Companies House and stop carrying it as a placeholder.
- [ ] **UK VAT registration number obtained** (B1 above) and recorded in: the legal pack, the website footer, Stripe's tax-ID field as a `gb_vat` value, and every developer-programme application.
- [ ] **Company and director verification completed with Stripe** (B2 above).
- [ ] **ICO data protection fee registration** completed and the number recorded.
- [ ] **Registered office address** and a **head-office address in Stripe → Tax → Settings** (a Stripe prerequisite, and the address most programmes also want).
- [ ] Decide and record the **trading name** used publicly. The repository carries *Neoting*, *Neo Accounting* and *Exam Binary Ltd*, and *Neovogent* appears as the support-email domain. Marketplace listings, legal pages and the developer-account company name should not disagree with each other — a reviewer who cannot tell who they are dealing with will ask, and that costs a review cycle.

### 3.3 Public web presence — every programme checks these resolve

- [ ] **A public marketing website** for the product, live, on its own domain, describing what it does. Several programmes reject applications from a landing page with no product description.
- [ ] **A published privacy policy at a stable public URL.** ⚠ `docs/legal/privacy-notice.md` exists but is marked **"NOT LEGAL ADVICE — DRAFTING AID ONLY"**, is unreviewed by a solicitor, and carries `[PLACEHOLDER]` markers. **Do not publish a page with a placeholder still in it — an unfinished legal page is worse than a missing one** (`docs/legal/README.md`).
- [ ] **Published terms of service** at a stable public URL (`docs/legal/terms-of-service.md`, same caveat).
- [ ] **A published refund/cancellation policy** (`docs/legal/refund-and-cancellation.md`) — already required by Stripe, and reused by marketplace listings.
- [ ] **Data processing terms** (UK GDPR Art. 28(3)) available to practices — `docs/legal/data-processing-terms.md`. **Required *before* a practice uploads a client's records**, which is before any pilot, let alone any application.
- [ ] **All 105 `[PLACEHOLDER: …]` markers resolved** across the four legal documents, and the "not legal advice" block deleted from each before publishing.
- [ ] **A solicitor's review** of the legal pack. Budget elapsed time for it.
- [ ] **A support contact route** that a reviewer can actually use, with a stated response time.
- [ ] ⚠ **Fix the support mailbox.** `docs/legal/privacy-notice.md` §6.4 records that support runs on what is believed to be a **free consumer Google account, which carries no Article 28 processor contract** — described in the notice itself as "the weakest link in this chain". A security questionnaire that asks where customer data is processed will surface this. Move it to a business plan with data processing terms in place.

### 3.4 Security posture — the part that takes longest to assemble

- [ ] **A named security contact** — a real person, a monitored address, and a stated response time.
- [ ] **A written security policy / trust page** you can hand to a reviewer.
- [ ] **A documented answer to "how do you store OAuth refresh tokens?"** This will be asked. Today `Integration.tokenRef` points at a vault that does not exist (§4.2). Build it, then describe it: envelope encryption, key management, rotation, who can decrypt, and the audit trail.
- [ ] **Penetration-test evidence**, where required (see the per-platform rows in §1 — requirements differ, and this is where the cost and the calendar time concentrate). A third-party pen test is typically a several-thousand-pound, several-week engagement, so start the procurement early even if only one platform demands it.
- [ ] **Data-residency commitments you can actually keep**, stated consistently. ⚠ Note the existing tension: `docs/legal/privacy-notice.md` §7.3 records that **the team works from Bangladesh**, and §7.4 carries an unresolved placeholder about whether backups leave the UK because "the UK has only one AWS region". Both matter to a UK data-residency answer and to an Australian one. Resolve them before you are asked, not after.
- [ ] **Transfer safeguards documented** for each non-UK supplier — `docs/legal/privacy-notice.md` §7.2 marks Stripe, Cloudflare and Google as needing the UK IDTA or the UK Addendum to the EU SCCs, and says "do not publish this clause until each one is checked".
- [ ] **Professional indemnity and cyber insurance**, where required — check the per-platform rows in §1. Even where it is not mandatory, practices buying the product will ask, and a partner agreement may require it contractually.
- [ ] **MFA on every developer-portal account**, and a named owner for each. Losing control of a developer account that holds live client-ledger connections is a category of incident worth designing against in advance.

### 3.5 Product artefacts a reviewer will ask for

- [ ] **A working demo environment** with credentials a reviewer can log into, and a scripted path through it.
- [ ] **A connect/disconnect flow that actually works** per client organisation (§4.2 — not built).
- [ ] **A support and error-handling story**: what a practice sees when a connection expires, when a post is rejected, when a rate limit is hit.
- [ ] **Screenshots and marketing copy** for the listing, sized to each marketplace's spec.
- [ ] **A stated position on what the app writes and when.** Neoting's answer is unusually strong — *nothing changes state without a human pressing Approve*, enforced server-side, not in the UI. **Lead with it.** It is the answer to the question every reviewer is really asking.

## 4. What Neoting must build before an integration is worth applying for

*This section is an audit of the actual repository at `/Users/mubasshir/neoting` as at 3 September 2026, not a wish list. Applying to a developer programme with none of this in place wastes the application; applying with most of it in place turns a review into a formality.*

### 4.1 What is already in place — more than you might expect

| Already built | Where | Why it matters to an application |
|---|---|---|
| **A `LedgerAdapter` interface, fully specified** | `apps/api/src/modules/publishing/ledger-adapter.ts` (148 lines) | The seam a real Xero or QuickBooks adapter drops into already exists, with its contract written down. Its own comment says *"Xero SDK + OAuth is the committed real implementation; this interface is the seam it drops in behind."* This is the difference between "we would need to architect an integration" and "we would need to write one class." |
| **Attachment as a first-class concept in that interface** | `LedgerAttachment { s3Key, filename, mimeType }` and `PublishBillRequest.attachment` | D43 through an API is already modelled. Critically, the success type carries **`attachmentSent: boolean`** — the design already refuses to claim silently that a document went with the bill when it did not. That honesty is exactly what an app reviewer rewards. |
| **Integer pence enforced right up to the adapter boundary** | `totalPence`, `taxPence` on `PublishBillRequest`; `canonical/money.ts` | The adapter receives integer pence. The decimal conversion happens at the vendor boundary and nowhere else. `formatPenceDecimal` does integer division and string concatenation — no float exists at any point. **Every platform in §1 that expresses money as a JSON decimal needs its own equivalent of this function inside its adapter.** |
| **Per-item failure as a result, not a throw** | `LedgerPublishResult` union; `LEDGER_REJECTED` = `NT-PUB-002` | A 500-item batch where item 12 is rejected publishes the other 499. Every rate-limited platform in §1 will hand you 429s mid-batch, and this is the shape that survives them. `retryable` is already on the failure type. |
| **External calls structurally barred from holding a tenant transaction open** | Same file, "Rule 1"; post-commit follow-up via `publish-follow-up.ts` | A Xero round trip inside an open `scopedDb` transaction would hold row locks for the length of someone else's network. The engine already writes `publishes` rows `QUEUED` and resolves them in short transactions afterwards. This is the single hardest thing to retrofit and it is done. |
| **Idempotency keyed at the caller** | `publishes.idempotency_key` = proposal id + document id | Independent of any vendor's idempotency support. Where a vendor *does* offer an idempotency key (see Xero and QuickBooks in §1), this row is the natural source of it. |
| **An `Integration` model with per-business token storage** | `prisma/schema.prisma` ~line 1319 | `businessId`, `kind`, `orgRef`, `tokenRef`, `tokenExpiresAt`, `health`, `lastSyncAt`, `lastErrorAt`, `isActive`, and a `@@unique([businessId, kind])`. **`orgRef` is the per-organisation tenant identifier every platform in §1 requires**, and `tokenRef` is an indirection rather than a token — the schema already assumes tokens live somewhere else. |
| **`IntegrationKind` already names the targets** | Same file, ~line 1310 | ⚠ **Correction of a common misreading.** The enum does **not** hold only `VT` and `MANUAL`. It holds six values: **`XERO`, `QUICKBOOKS`, `SAGE`, `FREEAGENT`, `VT`, `MANUAL`** — and the history runs the *opposite* way to the assumption. The enum was originally `{XERO, QUICKBOOKS, SAGE, FREEAGENT}`; `VT` and `MANUAL` were **added** in the ID launch batch (`docs/launch/SHAKIB.md` item c, `docs/launch/ABDULLAH.md`) precisely because `publish-batch.ts` refuses with *"this client has no active ledger connection"* and `resolveIntegration` is the only door — so **without a `VT` or `MANUAL` value nothing could ever reach `PUBLISHED`** and §24.7 could not run. The four ledger values are therefore present but inert, and the schema comment is explicit that VT and MANUAL "[n]either carries a token, an org ref or a health state, and neither may ever become an adapter call." **The enum is ready; the behaviour behind four of its six values is not.** Adding a seventh (`MYOB`, say) is a LAW change — see the governance note at the end of this section. |
| **`ReferenceSync`** | Same file, ~line 1347 | Two-way sync of reference lists so category dropdowns show the client's real chart of accounts. The table exists. This is how you would consume a ledger's chart of accounts and tax rates — which every platform in §1 requires you to do before you can set an account code on a bill. |
| **A canonical export model with per-target emitters** | `apps/api/src/modules/exports-public-api/canonical/`, `emitters/` | *"VT is an emitter, not the architecture — otherwise the second client is a rebuild."* The canonical row already exists as the single internal representation. An API adapter is conceptually one more emitter, though it lives in `publishing/`, not `exports-public-api/`. |
| **Capability links and a document bundle manifest** | `exports-public-api/links/`, `bundle/manifest.ts` | The D43 file-based answer already works. Through an API it is superseded by a real attachment — but the capability link remains the fallback for any platform that cannot attach (see §1). |
| **The Review → Approve gate, enforced server-side** | Governance §10; `validation-dedupe/proposals/publish-batch.ts` | Every app review in §1 asks some version of "can this app write to my books without me knowing?" The answer here is architecturally no, and `publish-batch.ts` already resolves an `Integration` before it will admit a document for publish, with `resolveIntegration` as the only door. |

> **One thing is actively moving in the opposite direction, and that is correct.** Launch task **M5, "The Xero purge"** (`docs/launch/MUBASSHIR.md` §M5) is removing Xero and bank-connection copy from the client-facing app — *"The app says 'Xero' in 87 places across 19 files and offers to connect a bank"*, nearly all driven by one boolean, `xeroConnected`. That is D42 being enforced honestly: the UI must not imply a ledger connection that does not exist. **Do not read this guide as a reason to stop that purge.** The backend seam stays; the promises come out of the UI. When an adapter is real, the copy comes back — earned rather than asserted.

### 4.2 What is missing — the honest list

| Missing | Severity | Notes |
|---|---|---|
| **Any real adapter at all.** `selectLedgerAdapter()` returns `new DemoXeroAdapter()` unconditionally — a single-arm switch, deliberately | Expected, not a defect | Its comment: *"`demo` is the only value today… no real vendor call may leave this codebase before the pilot."* This is D42 working as designed. |
| **OAuth: there is no authorization-code flow anywhere in the product** | ⚠ **The largest gap** | No redirect handler, no callback endpoint, no state/PKCE handling, no token exchange, no refresh scheduler. Every platform in §1 needs all of it. This is the work, and it is largely *shared* across platforms — build it once, generically, and each platform becomes configuration plus an adapter. |
| **A token vault.** `tokenRef` is an indirection to a store that does not exist | ⚠ High | Refresh tokens for hundreds of client organisations are among the most sensitive secrets the company will ever hold — each one is standing write access to a business's books. They need envelope encryption, key rotation, and an audit trail. Several platforms' security questionnaires (§2, §3) ask precisely how you store them. **Answering that question well is worth more in a review than any other single artefact.** |
| **A refresh scheduler / connection health job** | High | Platforms in §1 expire refresh tokens on inactivity. A practice with 200 quiet client organisations will silently lose connections unless something proactively refreshes them and surfaces `health` and `lastErrorAt` to the practice. The columns exist; the job does not. |
| **A per-organisation connect/disconnect UI for practices** | High | A practice connecting 200 clients one at a time needs a real management surface: which clients are connected, which have expired, reconnect, disconnect. Every platform requires the *user* to authorise each organisation individually — there is no bulk consent anywhere in §1. This UI is a genuine product surface, not plumbing. |
| **Chart-of-accounts and tax-rate sync against a live ledger** | High | SoT §24.2 stage 3 is explicit: *"there is no ledger-synced chart of accounts in ID"*. Coding runs against a platform-side COA seeded from a business-type profile. The moment you post to a real ledger, the account code and tax code must be **the client's own**, pulled from their organisation. `ReferenceSync` is the table; nothing fills it. |
| **Zod schemas for vendor responses** | Medium | The house rule is Zod at every boundary including adapter responses, and `ledger-adapter.ts` says so explicitly: *"A real adapter parses the vendor's HTTP response with Zod before returning."* None written. |
| **Rate-limit-aware batching and backoff** | Medium | The batch cap is up to 500 items; per-organisation limits in §1 are far tighter than that. A queue with per-tenant token buckets, honouring each vendor's rate-limit response headers, is needed before any pilot at real volume. |
| **Multi-currency** | Medium | `PublishBillRequest.currency` is ISO-4217 and present, but the product is sterling-first. An Australian second market means AUD, and cross-border clients mean foreign-currency bills with an exchange rate the ledger also holds an opinion about. |
| **A public privacy policy, terms and security page that actually resolve** | ⚠ Blocking for applications | `docs/legal/` carries **105 remaining `[PLACEHOLDER: …]` markers** across four documents (`docs/legal/README.md`), and the privacy notice is explicitly marked *"NOT LEGAL ADVICE — DRAFTING AID ONLY"* and un-reviewed by a solicitor. Every programme in §1 requires live, public URLs. **This is paperwork, not engineering, and it is on the critical path.** |

### 4.3 The order to build it in

1. **The generic OAuth 2.0 authorization-code layer plus the token vault.** Platform-agnostic. This one piece unlocks every platform in §1 and is the thing security questionnaires interrogate. Build it before you apply anywhere, because the questionnaire will ask about it.
2. **The per-organisation connection management surface** for practices — connect, health, reconnect, disconnect, per client business.
3. **The refresh scheduler and health job**, filling `health`, `lastSyncAt`, `lastErrorAt` on `Integration`.
4. **Chart-of-accounts and tax-rate sync** into `ReferenceSync`, and re-point coding at the client's real ledger codes.
5. **The first real `LedgerAdapter` implementation**, behind the existing seam, with Zod response parsing and its own pence→decimal conversion.
6. **Rate-limit-aware batching** with per-tenant buckets.

Steps 1–4 are **shared infrastructure**: they are paid for once and reused by every platform. Step 5 is the only genuinely per-platform cost. That asymmetry is the strongest argument for building the shared layer early even though D42 means nothing calls it yet — and it is also why the second platform costs a fraction of the first.

> **A governance note before any of this starts.** `prisma/`, `packages/contracts`, `packages/component-grammar`, `packages/tokens` and `packages/validators` are **LAW (G7)**. Adding a value to `IntegrationKind`, adding a token-vault table, or changing the `Integration` model requires a **contract-change issue approved by Shakib before a PR opens**. Budget for that step; it is not optional and it is not fast.

## 5. What could not be verified

*Listed rather than guessed, because a wrong connection limit or certification requirement sends you down an expensive path. Each row says who to ask.*

### 5.1 Things that could change a decision — chase these

| # | Unverified | Why it matters | Who to ask |
|---|---|---|---|
| 1 | **Whether MYOB will admit a UK-domiciled applicant with no ABN or Australian entity.** No ABN or entity requirement is *stated*, but MYOB has absolute discretion (clause 3) and no positive confirmation of a foreign admission was found | **The entire Australian plan rests on it** | MYOB developer support, in writing, at application |
| 2 | **Whether MYOB clause 34 prohibits an internal-only tool/MCP layer**, or only one exposed to third-party agents | Could constrain the product architecture, not just the integration | MYOB, in writing |
| 3 | **Whether Intuit treats an LLM API vendor as a prohibited "third party"** under *"Your app does not provide third-parties with access to a customer's QuickBooks data"* | **Neoting's least-charted compliance risk.** MYOB addresses this explicitly; Intuit is silent, and silence is ambiguity, not permission | Intuit, via the questionnaire or developer support |
| 4 | **The current 2026 Sage Developer Programme fee for Sage 50.** £2,500 + VAT/yr was published in 2023; a rise took effect 1 Aug 2025 and **Sage's KB redacts the new figure** | Decides whether Sage 50 is even a conversation | `isvdeveloperuk@sage.com` |
| 5 | **What the undocumented Sage 50 "Use third-party applications" login type is, and whether a Sage 50 cloud path is coming** | ⚠ **Could obsolete a £2,500, six-month COM-agent build immediately after you finish it** | `isvdeveloperuk@sage.com` |
| 6 | **Whether FreeAgent still imposes any historical approval gate** on connecting to third-party accounts. No current doc asserts it; none rescinds it | Load-bearing for the multi-tenant plan; a one-line email settles it | `integrationsrequests@freeagent.com` |
| 7 | **Codat's per-platform attachment support matrix** — specifically FreeAgent, Sage 50/Sage Accounting and MYOB | **D43 depends on it**, and Codat publishes no matrix | Codat sales, in writing |
| 8 | **MYOB and Reckon rate limits.** Neither publishes any. MYOB shows them per-app in the my.MYOB dashboard; Reckon sits behind Azure APIM | Cannot size the AU rollout without them | MYOB support; `apisupport@reckon.com` |

### 5.2 Figures and behaviours that could not be confirmed

| Platform | Not verified |
|---|---|
| **Xero** | The exhaustive **MIME allowlist for attachments** (the Xero Central page is behind bot protection) · Xero's **typical end-to-end certification review duration** — not published · whether Xero requests **pen-test evidence informally** during review · whether a **named security contact** is an explicit field · a **GBP price list** for the tiers (all prices are AUD) |
| **QuickBooks Online** | The **App Assessment Questionnaire's literal question list and approval SLA** · **UK Gold/Platinum GBP rates** and the AU rate card · whether a **KMS/HSM satisfies** the "AES key in a separate configuration file" wording · how **`POST /batch` meters** its constituent operations · any **per-file** (as opposed to per-request) attachment size cap · **UK availability of the QuickBooks Solution Provider programme** · whether any **MTD filing API path** exists |
| **Sage Accounting** | ⚠ **The attachment max file size** — the attachments swagger is not publicly archived and Sage publishes no limit. **Test empirically** · Marketplace **listing fee and revenue share** · **review duration and rejection criteria** · company registration/VAT/insurance/residency requirements (none published) |
| **Sage 50** | Whether the paid SDO help file documents an **attachment object** (AutoEntry's behaviour strongly implies not) · the **exact SDO field** used for link-attachments · purchase-side object names (`PopPost` etc.) — the reference is inside the paid help file · whether a **separate NDA** is required · the **External Integration Testing rate** · whether a **US Sage 50 REST API** ever existed and was withdrawn |
| **FreeAgent** | Gallery **listing fee and revenue share** · **review criteria and duration** · **whether sandbox data resets**, and on what schedule · **how the API behaves when a period is locked** and what error it returns · turnaround on the Practice Dashboard sandbox request |
| **MYOB** | **Rate limits** (not published) · **per-company-file limits** · marketplace **review duration, listing fee, revenue share** · whether **insurance** is required at any tier · whether the **Product/API Matrix is still current** (the article was last updated Dec 2022 and the Connected Ledger finding depends on it) |
| **Reckon** | **Reckon One access-token lifetime**; **refresh-token lifetime and rotation** · **rate limits** · **data-residency terms** (the developer agreement is not published) · **approval turnaround** · listing **review criteria, duration, fee and revenue share** · whether Reckon **dedupes** posts · AI/LLM terms — **not published at all** |
| **Zoho Books** | **Attachment max file size** — absent from the API reference · **revenue share** on Marketplace · **sandbox availability** (none documented) · whether **Free-plan API access** genuinely exists (the docs and the UK pricing page **contradict each other**) · **ATO/SBR lodgement status** for the AU edition |
| **Odoo** | **Attachment size limits** · **rate limits** (none documented in 18.0 or 19.0) · **2FA interaction** with API keys · UK/AU **market share** |
| **VT Transaction+** | Whether VT renders a **URL in a text field as a clickable hyperlink** — the internal working assumption that it does not remains the safe one · **field length limits** for Details/Entry details (the internal 104-character measurement is the only evidence) · whether an **undocumented COM/automation interface** exists in the binary · whether the **ledger/account-names import** exists (the trial-balance and journal imports are confirmed) · **current independent market-share data** |
| **Aggregators** | **Codat and Rutter pricing** (sales-only) · **Apideck rate limits** · the **Railz→FIS acquisition date** · whether **Chift** has UK/AU depth |
| **Cross-cutting** | Whether **Dext attaches the source image to MYOB** · whether **AutoEntry attaches on Xero and QBO** · **UK/AU market-share figures** generally — vendor self-reporting was available, independent data was not |

### 5.3 A methodology note, so the confidence level is legible

Three vendor sites actively resist automated reading, and this shaped what could be checked: **`developer.sage.com`, `www.sage.com` and `marketplace.sage.com` return HTTP 403 to all automated fetching** (Cloudflare), so Sage pages were read via the Wayback Machine or a text proxy — the URLs cited are canonical, but a small risk of staleness attaches to them. **`developer.xero.com` is a JavaScript-rendered SPA**; its content was retrieved through the underlying page-data endpoint and by rendering, **and the tier pricing table exists only in rendered form — it is absent from the page's JSON payload**, which is very likely why the 2 March 2026 pricing change is not yet reflected in third-party writing. **Xero Central attachment pages sit behind Akamai bot protection** and could not be read at all.

**Where a vendor's own pages contradict each other, both are cited and the authoritative one is named.** There are four such contradictions in this document and they are worth knowing about, because each one is a trap someone has already fallen into:

- ⚠ **Xero's connection limit** — three Xero pages still say **25**; the tier table and pricing FAQ say **5**. (§1.1.4)
- ⚠ **Xero's request size** — the same page says both 10 MB and 3.5 MB. (§1.1.7)
- ⚠ **Intuit's batch limit** — the overview page says 10; the entity reference and limits page say **30**. (§1.2.6)
- ⚠ **Zoho's Free-plan API access** — the API docs quote a 1,000/day free quota; the UK pricing page lists API Access as a **Standard-tier** feature. (§1.10)

And one contradiction between this research and the repository's own record, flagged rather than resolved: **SoT §24.3.1 records that VT's Universal Input Sheet "has no import command of any kind", but VT's published help documents `Import from: CSV File / Text File / Clipboard` on the UIS.** See §1.15.2. The D42/D43 decision stands either way — the journal route the product built is valid, and the UIS could not carry a split-analysis purchase invoice regardless — but the discrepancy should be resolved on the licensed install rather than left standing.

---

*Prepared 3 September 2026. Every non-obvious claim carries a source URL. Figures on developer-programme pricing, connection limits and rate limits change without notice — the four platforms whose commercial models changed during 2025–26 alone are Xero, Intuit, MYOB and Sage. **Re-verify anything load-bearing before acting on it.***
