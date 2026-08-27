# Mubasshir — brand and surface

Read `docs/launch/PLAN.md` first. It holds the rules, the dependency order and what "done"
means. This file holds your stages.

**To run one:** attach the codebase and this file, then say *"Finish stage M2."*

Two rules that will save you the most trouble, because nothing in CI catches either:

- **Never put a hex colour in a className.** `bg-[#16161a]` is invisible to every lint rule
  and silently breaks the light theme. Use the tokens: `bg-card`, `text-brand`,
  `bg-ground`, `text-pale`.
- **Never put a bare string in JSX.** `neoting/no-literal-string-in-jsx` is an ESLint
  **error**, so it will stop your build. Every user-visible string goes through react-intl
  with a proper `domain.component.purpose` id — including `aria-label`, `title`,
  `placeholder` and `alt`, which are all copy.

**Start with M2 and M5, together.** They are the only two of yours that need nothing at
all, and they touch different files.

**Then M1, and not before M5 is merged.** M1 renames user-facing strings; M5 deletes a
large number of user-facing strings. Running them at once means renaming copy that is
about to be deleted, and a merge conflict in every view you both opened. M5 first is
maybe twenty minutes of waiting and it removes the conflict entirely.

The rest unlock as their `Needs` land: M3 after M1 · M4 after M3 · M6 once Shakib's S2
is up · M7 once Abdullah's A11 is up · M8 last, after every stage that writes copy.

**Who owns the tour.** Three stages reach into it, so split it explicitly: **M2 owns tour
*behaviour*** (`TourProvider.tsx`, the `/demo` route, the gating). **M5 then M1 own tour
*prose*** (the step text). Do not edit the other's half.

---

## M1 · Neoting becomes Neo Accounting

**Needs:** M5 — see below, this is not optional ordering.
**Owns:** user-facing strings, `apps/web/index.html`, `apps/web/src/assets/`, tour step prose.

> **Wait for M5 to merge.** M5 deletes the Xero and bank-connection copy across the client
> and settings views and rewrites the publish surfaces. If you rename in parallel you will
> rename strings that no longer exist by the time you merge, and you will conflict with
> yourself in six files. Do M5, merge it, then rename what survived.

```
Rename the product from "Neoting" to "Neo Accounting" in USER-FACING STRINGS ONLY, and
build the wordmark.

⚠ SCOPE. 260 files contain "neoting". You are changing roughly 40. CHANGE:
- react-intl message defaults in apps/web (the visible copy)
- <title> in apps/web/index.html — it currently reads "AI Accounting Operations Platform"
  on every route, which is the browser tab in every sales demo
- email templates and transactional copy
- the tour's step prose
- README's user-facing description
- LoginView.tsx, which still says "Sign in to Neoting"

DO NOT CHANGE, and this matters more than the rename itself:
- @neoting/* package names
- nt-* AWS resource names or anything in infra/
- database identifiers, table names, prisma models
- env var names, import paths
Renaming those means a Terraform migration and a package-rename cascade mid-launch.

THE WORDMARK. The icon is at the repo root as the favicon: an "N" drawn as a single
continuous stroke with a round node at each end — a path from one point to another. That
is the idea to carry: a document goes in one end, a ledger entry comes out the other.

Build a lockup component, not an image:
- Keep the existing N mark as an SVG using `currentColor` so it inherits the theme.
- Set "Neo Accounting" beside it in the app's own font. Do NOT embed a font in an SVG —
  it will silently fall back. Render it as real text in a component.
- Suggested treatment: "Neo" in the heavier weight, "Accounting" lighter, tight tracking,
  optically aligned so the mark's baseline matches the type. Give it a `title` prop and a
  size prop, and use it in the header, the login view and the landing page.

Run pnpm --filter @neoting/web i18n:extract afterwards and confirm no message id was
orphaned. Full gate. PR.
```

---

## M2 · Stop showing customers fake data

**Needs:** nothing — start here.
**Owns:** `apps/web/src/api/slices.ts`, `context/AppContext.tsx`, `components/DataSourceBadge.tsx`, and tour **behaviour** (`tour/TourProvider.tsx`, the `/demo` route). Not the tour's prose — that is M5's then M1's.
**Blocker.** This is the one that would embarrass you in front of a paying accountant.

```
The web app ships a synthetic demo cast and silently falls back to it. Three separate
mechanisms, all of which must go in production:

1. apps/web/src/api/slices.ts defines a 'seed-fallback' path — when an API slice fails, it
   DEGRADES TO SEEDED DEMO DATA rather than showing an error. A paying accountant whose API
   call fails sees "American Burger Ltd" and a set of invented invoices, and has no way to
   know they are not real. Replace it with an honest error state that says the data could
   not be loaded and offers a retry.

2. apps/web/src/context/AppContext.tsx initialises useState<Client[]>(seedClients) with no
   API_ENABLED condition, so the demo cast is the starting state for everyone.

3. apps/web/src/components/DataSourceBadge.tsx returns null unless import.meta.env.DEV — so
   the one signal that would have told the user "this is demo data" is invisible in exactly
   the build where it matters.

Fix all three so that in a production build the app shows REAL data or an HONEST ERROR, and
never invented data presented as real.

Also: /demo remains a live-reachable route that starts the scripted tour over whatever data
is loaded (TourProvider.tsx owns it). Gate it to synthetic mode, the same way the tour
button already is.

⚠ This is the highest-trust-cost bug in the product. An accountant who discovers the
numbers were fabricated does not file a bug report, they leave.

Full gate. PR.
```

---

## M3 · The landing page

**Needs:** M1. **Owns:** `apps/web/src/views/LandingView.tsx`, routing for `/`.

```
Build the public landing and pricing page as a lazy route at "/" — the app lives under
/app. It must render OUTSIDE the login wall.

WHAT THE PRODUCT IS, in your own words on the page: UK accounting practices use Neo
Accounting to collect their clients' receipts and invoices, read and code them
automatically, chase the client for what is missing, and produce a VT Transaction+ import
file — with the original document reachable from every line. A human approves before
anything changes.

⚠ SAY WHAT IT ACTUALLY DOES. It produces a file the accountant imports into VT. It does NOT
post to a ledger, does NOT connect to a bank, does NOT sync with Xero, does NOT file with
HMRC. D42 forbids implying otherwise and a pricing page is the most public surface there is.

PRICE: £8.50 + VAT per month, per client business. One tier. Display it as
"£8.50 + VAT per month" — never a bare figure, because prices are stored exclusive of VAT.

SUPPORT: email support, 24-hour response, 06:00–18:00 UK. State the hours.

⚠ COMPANY IDENTITY IN THE FOOTER — this is a legal requirement, not a design choice. The
Companies (Trading Disclosures) Regulations require the registered company name, company
number and registered office on the website. The VAT number belongs there too. Shakib
supplies the exact values; use [PLACEHOLDER] and flag it rather than inventing them.

Link the four legal pages from the footer (M4 builds them).

Every string through react-intl. Design tokens only. Keep the route inside the 250 KB
gzipped budget — the landing page must not drag the app bundle down.

Full gate. PR.
```

---

## M4 · The legal pages

**Needs:** M3, and Shakib's S6 review. **Owns:** `apps/web/src/views/legal/`.

```
Four documents are drafted in docs/legal/: terms-of-service.md, privacy-notice.md,
data-processing-terms.md, refund-and-cancellation.md.

Render them as public pages under /legal/*, reachable from the landing-page footer AND from
the client portal before anyone uploads anything.

⚠ THE PRIVACY NOTICE MUST BE REACHABLE AT THE POINT OF COLLECTION. UK GDPR Art. 13
requires it where data is collected, so it needs a link on the portal sign-in and upload
screens, not only in a footer.

⚠ DO NOT PUBLISH A DOCUMENT WITH A [PLACEHOLDER] STILL IN IT. Grep for it first. If one is
unresolved, stop and tell Shakib which — an unfinished legal page is worse than a missing
one.

Render the markdown rather than retyping it, so the source of truth stays in docs/legal/
and a correction does not have to be made twice. A small markdown renderer or a build-time
transform both work; pick the one that adds less to the bundle.

These pages are read under stress — by someone deciding whether to trust you with their
clients' records. Set them for reading: a comfortable measure, real heading hierarchy,
numbered clauses visible so support can cite one.

Full gate. PR.
```

---

## M5 · The Xero purge

**Needs:** nothing — start here, alongside M2. **M1 is waiting on this one**, so it is
worth more than its size suggests.
**Owns:** `apps/web/src/lib/types.ts`, `apps/web/src/api/proposals.ts`, the client and
settings views, and the tour prose covering publish and connections.

```
Read D42, D47 and D40. This is a mechanical pass, not a redesign — resist improving the
screens while you are in them.

The app says "Xero" in 87 places across 19 files and offers to connect a bank. Both
contradict merged decisions: D42 removes the ledger API, D47 removes connections from
onboarding, D40 makes upload the only bank input.

It is nearly all driven by ONE boolean: xeroConnected in apps/web/src/lib/types.ts. Delete
the field and the surfaces follow.

- Remove ledger and bank connection sections from ClientDetailView, ClientsView,
  ClientInbox, SettingsView, ClientIntakeForm, BusinessSettingsView.
- Rewrite the publish surfaces. Published means approved and released for export and
  asserts NOTHING about a ledger. No "posted", no "synced", no "sent to Xero", no
  "connection health", no "the reference Xero gave it".
- Use "Export for VT" / "Download VT import file". NEVER "Send to VT" — that implies
  transmission and D42 forbids it just as much as Xero did.

⚠ TWO EXACT STRINGS, handed over from Abdullah's S0 review. Both say "Publish to the
  ledger", which is the one phrase D42 forbids in as many words — and both are the label a
  user reads at the moment they approve, so they are the worst two in the app:
  • apps/web/src/api/proposals.ts:45  — the publish.batch proposal kind label
  • apps/web/src/tour/steps.ts:173     — inboxesPublishTitle
  Grep "Publish to the ledger" and "ledger" across apps/web/src before you call M5 done;
  the count should be zero outside comments. Published asserts nothing about a ledger.
- Drop the five Xero steps from tour/steps.ts and the "connect their own Xero and bank"
  line from the client-add copy.
- ChaseComposer.tsx builds its SMS preview with a literal fake domain and a random suffix.
  Replace it with the real portal link shape.
- Update the demo fixture: "Cosmo Restaurants" was renamed "Ananda Group" upstream and the
  rename did not come across.

Every replacement through react-intl with a proper id. Run i18n:extract and check for
orphaned ids. Full gate. PR.
```

---

## M6 · Sign in by email

**Needs:** S2 (email transport), and the S0 portal-onboarding surface.
**Owns:** `apps/web/src/views/business/`.
**Bigger than it looks — read the warning.**

```
Read apps/api/src/modules/portal/portal-session.service.ts before you start.

⚠ A PORTAL SESSION CAN ONLY EXIST AS THE CONSEQUENCE OF A CHASE. createSession takes
{ linkToken, otp }, calls verifyPortalLink, then resolveChase(link.chaseId) and returns 401
if the chase is gone. The contract documents /portal/sessions as "Open a portal session
from a chase link". OtpSessionScope.ONBOARDING is declared in the schema and nothing
implements it.

So "the client signs in to complete onboarding" has no path today — there is no chase yet
when a client is first invited. That is why S0 adds a portal-onboarding surface and makes
OtpSession.businessId nullable.

⚠ COORDINATE WITH ABDULLAH. The server half of this is his; you own the screens. Agree the
shape before either of you starts, or you will build against an endpoint that does not
match.

WHAT YOU BUILD:
1. The invited client lands on a link, enters their email, receives a six-digit code, and
   signs in. Copy says "we've emailed a six-digit code to …" — never "text", there is no
   SMS.
2. They complete their own onboarding, then subscribe.
3. ONE PRICE: £8.50 + VAT per month, displayed exclusive of VAT and labelled as such. No
   tier picker, no comparison table.
4. A "Plan" section in settings: status, renewal date, and a link to Stripe's hosted
   customer portal for card changes and cancellation. Do NOT build a plan-change UI, a
   cancellation flow or an invoice renderer — Stripe hosts all three.

⚠ Link the privacy notice on the sign-in screen and above the upload control. Art. 13
requires it at the point of collection.

react-intl for every string, design tokens for colour. Full gate. PR.
```

---

## M7 · The client intake screen

**Needs:** A11 (the API). **Owns:** `apps/web/src/views/ClientsView.tsx`, `ClientIntakeForm.tsx`.

```
Build the client intake and client list screens against the API Abdullah shipped in A11.

D47: the intake form asks for NO bank connection and NO accounting-software connection. If
the design you are copying has those steps, remove them — they were correct for v1 and are
wrong for this release.

It MUST capture the business type (the first client is a cleaning agency). That field is
not cosmetic: §24.4 makes it the only coding context the AI gets, because there is no
ledger-synced chart of accounts, and A6 seeds the chart of accounts from it.

Then the invite: the accountant triggers a registration email, and the client signs in with
a code and completes their own onboarding (M6).

Reuse the existing components rather than inventing new ones — the app already has a
DynamicComponents library and an intake form shape. Match it.

react-intl for every string, design tokens for colour, no hex literals. Full gate. PR.
```

---

## M9 · Signing up — the screens that do not exist

**Needs:** Abdullah's A14 on main. **Owns:** `apps/web/src/views/signup/`, routing for `/signup`.
**Not optional and not small: today an accountant cannot create an account in a browser.**

```
A1 shipped POST /v1/practices and it works in production. NOTHING IN apps/web/src CALLS
IT - no createPractice, no /v1/practices - and the landing page's only buttons are
#pricing anchors and a mailto. So the product has a login page and no way to reach it.

FOUR SCREENS:
1. Signup form - practiceName, firstName, lastName, email, password (min 12),
   acceptedTermsVersion. The terms version MUST be exactly "0.1" -
   TERMS_VERSION_IN_FORCE in practice-signup.service.ts. Any other value is a 400.
   Link the checkbox to /legal/terms, which M4 already built.

2. "Check your email" - and this is the one that needs care. THE API ALWAYS ANSWERS 202
   WITH AN EMPTY BODY, whether or not an account was created. That is deliberate: saying
   so would answer "is this email registered here" for anyone who asks. So the screen must
   NOT say "account created" and must NOT say "that email is already registered". It says
   what happens next, and nothing about what just happened.

3. The verify-link landing - reads the token from the URL, posts it, shows success or
   "this link has expired, request another". Nothing else; invalid and expired are the
   only two outcomes the API distinguishes.

4. TOTP enrolment - QR from the otpauth:// uri, the base32 secret underneath for manual
   entry, then TEN RECOVERY CODES SHOWN EXACTLY ONCE. Make the user confirm they have
   saved them, then make them type a code from the authenticator before enrolment
   completes. That second step is what stops a skewed clock locking someone out for ever.

Never put the secret, the recovery codes or the token in a URL, in a log, or in an error.

The usual two: no bare strings in JSX (react-intl, lint ERROR), no hex colours in a
className (use the tokens).

Full gate. PR.
```

---

## M8 · The last honest-copy pass

**Needs:** M1, M3, M4, M5 — every stage that writes user-facing copy. This one is last.
**Owns:** copy across `apps/web/src`.

> It was listed as needing only M1 and M5. It cannot be: it sweeps *all* copy, and M3 and
> M4 both add pages full of it. Sweeping before they land means sweeping twice.

```
A sweep for copy that is now wrong. Small, but these are what a customer notices first.

- LoginView.tsx instructs the user to enter "the six-digit code from your authenticator
  app". After A2 that is true for the accountant, and after M6 the CLIENT gets an emailed
  code instead. Make each screen say the right thing.
- Anywhere still saying "text message", "SMS" or "we'll text you" — there is no SMS.
- Anywhere implying a bank connection, a Xero sync, or an HMRC filing.
- Any hardcoded figure, fake chart or invented number rendered as if it were real data.
- Empty states: what does a brand-new practice with no clients actually see? A screen built
  against seeded data usually has no empty state at all, and the first thing your first
  customer sees is an empty one.

⚠ The empty states are the item on this list most likely to be skipped and most likely to
be seen. A new practice, a new client with no documents, an inbox with nothing in it, an
export with nothing to export — check every one.

Full gate. PR.
```
