/**
 * The public seam of chase (Boundaries, apps/api/CLAUDE.md).
 *
 * What is exported here is the whole of what other modules' code may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional. Growing
 * this list is a boundary decision — a name here is a name every other module is
 * allowed to build against, which makes it this module's API in the G7 sense
 * minus the contract file. Read the note in `ingestion-routing/index.ts` for the
 * shape rationale.
 *
 * This is the FOUNDATIONAL seam other Stage 8/9 agents build against:
 *
 *  - **The `chase.send` executor** (`modules/validation-dedupe/proposals`, the
 *    #81 executor home) consumes the SMS sender, the composition and the portal
 *    token from here — it is the first cross-module consumer.
 *  - **The OTP portal** (`modules/*`, METH Stage 9) verifies the portal-link
 *    token this module mints (`verifyPortalLink`) and reads the chase's items.
 *  - **Auto-close on inbound match** (the extraction/ingest hook, another agent)
 *    lands behind the seam reserved below — the one thing this seam names but
 *    does not yet implement.
 */

// The chased-item projection, for the OTP portal (METH Stage 9). `GET
// /portal/context` shows the client the SAME items the accountant sees on the
// chase detail — supplier, signed integer pence, booked date, and whether the
// paperwork has arrived — so it projects through THIS function rather than
// growing a second opinion about what a chased item is. `chaseItemRefs` narrows
// the bare `Json` column the executor writes; `isChaseReceivedClose` is the
// chase-level half of `received`.
//
// ⚠ `toChaseItem` returns the CONTRACT's `ChaseItem` (`@neoting/contracts/model`),
// which is not the `ChaseItem` this seam exports below from `sms-copy.js` — that
// one is composition's input. Import the contract type from the contract.
export { chaseItemRefs, isChaseReceivedClose, toChaseItem } from './chase-projection.js';

// Detection engine (a) — the unmatched, non-suppressed, not-already-chased
// transactions a chase covers, and the suppression predicates the read applies.
// `alreadyChasedTransactionIds` is the DO-NOT-OVER-ASK set (launch stage A13),
// exported so a composer can show why a line is absent without rebuilding the
// rule; `isChaseSuppressed` is the descriptor half.
export {
  alreadyChasedTransactionIds,
  type ChaseCoverageRow,
  detectUnmatchedChases,
  type UnmatchedTransaction,
} from './detection.js';
export { isChaseSuppressed, SUPPRESSION_DESCRIPTORS } from './suppression.js';

// Composition — the pure SoT-verbatim SMS copy and its money/date formatters.
export {
  type ChaseItem,
  type ComposeChaseInput,
  composeChaseSms,
  composeSignInCodeSms,
  composeStatementRequestSms,
  formatDay,
  formatGbp,
  formatPeriod,
} from './sms-copy.js';

// Statement-request chases (engine (c), Phase 5): the itemRefs tag format, the
// shared received/coverage predicate, and the close the statement lane runs
// inside its own ingest transaction.
export {
  closeStatementRequestChases,
  type CloseStatementRequestsInput,
  periodWindow,
  type StatementChaseClient,
  statementCoversPeriod,
  statementItemRef,
  statementPeriodOf,
  STATEMENT_ITEM_PREFIX,
} from './statement-request.js';

// The signed portal-link token — minted here (Stage 8), verified by the portal
// (Stage 9). One format, one place.
export {
  PORTAL_LINK_DEFAULT_TTL_SECONDS,
  type PortalLinkClaims,
  type SignPortalLinkInput,
  signPortalLink,
  type VerifyPortalLinkResult,
  verifyPortalLink,
} from './portal-link.js';

// The chase sender seam and its config selector — the `chase.send` executor and
// the worker composition roots wire the selected sender. ONE seam, two
// transports: `DemoSmsSender` writes the outbox and sends nothing;
// `EmailChaseSender` (launch stage A13) delivers by email through the S2
// notifications transport, carrying the REVIEWED body byte-for-byte. Which one
// is chosen by `SMS_SENDER`, config and never import — so the executor, and
// every call site, is identical either way.
export {
  DemoSmsSender,
  type OutboundSms,
  type SentSms,
  type SmsSender,
} from './sms-sender.js';
export {
  CHASE_EMAIL_CHANNEL,
  CHASE_EMAIL_SUBJECT,
  type ChaseEmailTransport,
  type ChaseEmailTransportFactory,
  EmailChaseSender,
} from './email-chase-sender.js';
export { type ChaseSenderEnv, selectSmsSender } from './select-sms-sender.js';
export { type AwsSmsTransport, type AwsSmsTransportConfig, createAwsSmsTransport, OptedOutRecipientError } from './aws-sms-transport.js';

// Auto-close on inbound match (SoT §4 Stage 8.5 / METH Stage 8): when an
// ingested document matches an open chase's transaction (supplier + amount + a
// date window), the chase closes automatically, the close is written to the
// chase's event log, and the accountant gets an in-app notification. The
// ingest/extraction hook calls `ChaseAutoClose.run` THROUGH this seam rather
// than reaching in; the worker composition root wires `PrismaChaseAutoClose`
// and the ingest-processor unit tests use `RecordingChaseAutoClose`. The pure
// compare (`chaseMatchesDocument`) and its tolerances are exported for the
// callers and their tests.
export {
  CHASE_MATCH_AMOUNT_TOLERANCE_PENCE,
  CHASE_MATCH_DATE_WINDOW_DAYS,
  type ChaseAutoClose,
  type ChaseAutoCloseInput,
  type ChaseAutoCloseResult,
  type ChaseCandidateDocument,
  chaseMatchesDocument,
  type ChaseTargetTransaction,
  normaliseSupplier,
  PrismaChaseAutoClose,
  RecordingChaseAutoClose,
} from './auto-close.js';
