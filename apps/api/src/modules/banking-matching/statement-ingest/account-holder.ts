import type { CompletenessFinding } from './completeness.js';

/**
 * **Whose statement is this?** — the account-holder check (5 Sep 2026, review
 * item 14).
 *
 * A real 1,491-row NatWest statement of *American Burger Ltd* was uploaded into
 * *Zeplow Inc*'s workspace and imported silently: every defence this lane has
 * is about the FILE (completeness, duplicates, overlap), and none of them asks
 * whether the file belongs to the business it is landing in. The extractor had
 * read the holder's name off the page (`documents.customer_name`); nothing
 * compared it to anything.
 *
 * **The check FLAGS, it never blocks** (D46). A mismatch becomes a
 * `gapAnalysis` finding — the same channel `periodOverlap` and
 * `alreadyImported` ride, rendered on the Statements tab with no contract
 * change — plus a WARN in the log. The import itself proceeds: the accountant
 * may genuinely be filing a trading-name or personal-account statement, and
 * removal has an approved path (`bank.remove-statement`). What must never
 * happen again is the SILENT part.
 *
 * **The comparison only speaks when it can.** D41's ethos, one lane over: a
 * spreadsheet statement has no extracted holder (`customerName` is hard-coded
 * null there), and a preamble that simply omits the holder proves nothing — so
 * no holder means no finding, never a guess. The flag fires only when a holder
 * WAS read and it does not match any name the business goes by.
 *
 * Pure — no Prisma, no session — so a test drives every case directly.
 */

/**
 * Words that carry no identity: legal suffixes and glue. "American Burger Ltd"
 * and "American Burger Limited" are the same holder; "The Zeplow Company" and
 * "Zeplow" are the same business.
 */
const NOISE_TOKENS = new Set([
  'ltd',
  'limited',
  'plc',
  'llp',
  'lp',
  'inc',
  'incorporated',
  'cic',
  'co',
  'company',
  'the',
  'and',
  't/a',
  'ta',
]);

/** Lowercased significant tokens — punctuation stripped, noise words dropped. */
function significantTokens(value: string): string[] {
  const cleaned = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token !== '' && !NOISE_TOKENS.has(token));
  return cleaned;
}

/** `a ⊆ b` over token sets. */
function subset(a: readonly string[], b: readonly string[]): boolean {
  const bag = new Set(b);
  return a.every((token) => bag.has(token));
}

/**
 * Does the extracted holder plausibly name this business?
 *
 * Match iff one side's significant tokens are a subset of the other's — so
 * "Zeplow" matches "Zeplow Inc", "American Burger Ltd" matches "American
 * Burger", and neither matches the other. Symmetric on purpose: banks
 * abbreviate and workspaces carry trading names, and the direction of the
 * abbreviation is not knowable from here.
 *
 * ⚠ The safe failure direction is a MISSED flag, not a false one — a missed
 * flag is the status quo; a false flag is noise a human dismisses. Subset (not
 * mere overlap) keeps "American Pie Ltd" from matching "American Burger Ltd"
 * on the shared word.
 */
export function holderMatchesBusiness(holder: string, businessNames: readonly string[]): boolean {
  const holderTokens = significantTokens(holder);
  if (holderTokens.length === 0) return true; // nothing readable to disagree with
  return businessNames.some((name) => {
    const nameTokens = significantTokens(name);
    if (nameTokens.length === 0) return false;
    return subset(holderTokens, nameTokens) || subset(nameTokens, holderTokens);
  });
}

/** The chase-verdict rule for untrusted names on their way into a sentence. */
function presentable(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 59)}…` : collapsed;
}

/**
 * The finding, or null when there is nothing provable to say.
 *
 * Null when: no holder was read (spreadsheets, unbriefed older extractions),
 * the holder is unreadable noise, or it matches. The detail names BOTH sides —
 * the holder is untrusted content, whitespace-collapsed and clamped, never
 * handed to a model.
 */
export function accountHolderFinding(
  accountHolder: string | null | undefined,
  businessNames: readonly string[],
): CompletenessFinding | null {
  if (accountHolder === null || accountHolder === undefined) return null;
  const names = businessNames.filter((name) => name.trim() !== '');
  if (names.length === 0) return null;
  if (holderMatchesBusiness(accountHolder, names)) return null;
  return {
    kind: 'accountHolderMismatch',
    sourceLine: null,
    detail: holderRefusalText(accountHolder, names[0]!),
  };
}

/**
 * The refusal an accountant reads when a statement is turned away for naming
 * somebody else (owner, 8 Sep 2026).
 *
 * ⚠ **This REJECTS now, where it used to flag.** The old sentence ended
 * *"its transactions were imported here — remove the statement if it was
 * not"*, which is the D46 posture: flag, never block, the accountant decides
 * after the fact. The owner overruled it for this one case and the reason is
 * the blast radius: a receipt in the wrong client's books is one document a
 * human will notice, and a STATEMENT is ninety-two bank lines that immediately
 * become the client's reconciliation surface, their unexplained totals and
 * their chase queue. Undoing that is `bank.remove-statement` — a proposal, an
 * approval and a cascade — where refusing it costs one re-upload.
 *
 * ⚠ **So the sentence has to carry the way through, or the rule is a wall.**
 * The comparison already accepts the client's TRADING NAME as well as its
 * registered one (`statement-step.ts` passes both), so a business genuinely
 * banking under another name has a one-field fix and the refusal names it.
 * Without that clause this is the "unacceptable documents are flagged, never
 * blocked" failure D46 exists to prevent.
 */
export function holderRefusalText(accountHolder: string, clientName: string): string {
  return (
    `This statement names “${presentable(accountHolder)}” as the account holder, ` +
    `but this client is “${presentable(clientName)}”. Nothing was imported — no transaction ` +
    'from this file has been added to the books. If that name is how this client banks, put it ' +
    "in the client's trading name and upload the statement again; otherwise upload it to the " +
    'client it belongs to.'
  );
}
