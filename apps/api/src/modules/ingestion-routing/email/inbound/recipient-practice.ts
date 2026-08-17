/**
 * Resolve the practice a `doc+<practice>@…` recipient identifies (issue #17).
 *
 * The single platform address is `doc@` (SoT §4 Stage 1.2). A practice-specific
 * sub-address `doc+<practiceId>@` is what carries the tenancy anchor an unrouted
 * email otherwise lacks: `documents.practice_id` is the only thing the
 * `documents_tenant_anchor` CHECK accepts for a document with no business, and
 * `email-intake.ts` already makes `practiceId` a REQUIRED caller-supplied dep for
 * exactly this reason. The local part before `+` is ignored; the tag after it, up
 * to the `@`, is the practice id.
 *
 * ⚠ TENANCY CAVEAT (flagged on #78 / #17). The recipient is chosen by the SENDER,
 * so a plus tag is only as safe as the practice id is unguessable. Practice ids
 * are cuid/uuid, and a document lands UNROUTED for a human to review — so a
 * misdirected email surfaces in a queue rather than granting any access — but the
 * real fix is the SES receipt rules encoding this mapping (issue #17), after which
 * this parser becomes a fallback rather than the authority. Returns `null` when
 * there is no usable tag; the caller must NOT silently drop that email — it is
 * left visible in the source and logged, never persisted without an anchor.
 */
/**
 * What a practice id is allowed to look like at this boundary. The tag is
 * SENDER-CHOSEN text that becomes `documents.practice_id` and a segment of the
 * unrouted S3 key (`w/_unrouted/<practiceId>/…`), so it is validated for shape
 * before it is allowed to be either: ids here are cuid/uuid-class tokens, so
 * anything outside `[A-Za-z0-9_-]` — a slash, a dot-dot, a quote, whitespace, a
 * control character — is not a practice id, it is an injection attempt or a
 * typo, and both resolve the same way: no anchor, quarantined, visible.
 * Existence is NOT checked here (no DB in this parser) — a well-shaped id for
 * no real practice fails loudly downstream, where `resolveSystemActor` refuses
 * to write anything for a practice with no SYSTEM actor.
 */
const PRACTICE_TAG = /^[A-Za-z0-9_-]{1,64}$/;

export function resolvePracticeFromRecipient(recipient: string | null): string | null {
  if (recipient === null) return null;

  // Accept a bare address (`doc+p@x`) or a header form (`"Name" <doc+p@x>`).
  const angle = recipient.match(/<([^>]+)>/);
  const address = (angle?.[1] ?? recipient).trim();

  const at = address.indexOf('@');
  if (at === -1) return null;

  const localPart = address.slice(0, at);
  const plus = localPart.indexOf('+');
  if (plus === -1) return null;

  const tag = localPart.slice(plus + 1).trim();
  return PRACTICE_TAG.test(tag) ? tag : null;
}
