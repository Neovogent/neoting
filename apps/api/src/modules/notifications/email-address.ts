import { z } from 'zod';

/**
 * The one place an email address enters this module (R4: parse, don't trust).
 *
 * Two things are being defended, and only one of them is obvious.
 *
 * **The obvious one:** a malformed address is a bounce, and bounces are the
 * currency SES suspends an account over — 5% and sending stops for everyone
 * (`infra/envs/staging/observability.tf`, `ses_bounce_rate`). A recipient that
 * was never going to resolve should never leave this process.
 *
 * **The one worth writing down:** CR and LF are refused explicitly. SES v2's
 * `SendEmail` takes a structured JSON body, so a newline in an address cannot
 * forge a header the way an SMTP `To:` line could — but this module is the
 * chokepoint every future transport passes through, and the day someone adds a
 * raw-MIME sender (`SendRawEmail`, an attachment, a calendar invite) the
 * injection becomes real with no change at any call site. Refusing it here
 * costs a regex and removes the class.
 */

/** RFC 5321's limit on a whole address. Anything longer is a bug or an attack. */
const MAX_ADDRESS_LENGTH = 254;

/**
 * Deliberately NOT an RFC 5322 grammar. A conforming address may contain
 * quoted strings, comments and folding whitespace; accepting them buys nothing
 * (no real client mailbox uses one) and costs the CR/LF guarantee above. This
 * is the shape every mail provider on earth actually accepts.
 */
const ADDRESS_SHAPE = /^[^\s@,;:<>"\\]+@[^\s@,;:<>"\\.]+(\.[^\s@,;:<>"\\.]+)+$/;

export const EmailAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(MAX_ADDRESS_LENGTH)
  .refine((value) => !/[\r\n]/.test(value), {
    message: 'an email address may not contain a carriage return or newline — header injection',
  })
  .refine((value) => ADDRESS_SHAPE.test(value), {
    message: 'not a deliverable email address',
  });

/**
 * A validated recipient. A branded string rather than a bare one so a raw
 * `string` cannot be passed where a parsed address is required — the same move
 * `ScopeContext` makes for tenancy, applied to the thing that decides where
 * a client's financial paperwork is delivered.
 */
export type EmailAddress = string & { readonly __brand: 'EmailAddress' };

/** Parse or throw. A bad address is a caller bug, not a runtime condition. */
export function parseEmailAddress(raw: string): EmailAddress {
  return EmailAddressSchema.parse(raw) as EmailAddress;
}

/**
 * The rate-limit identity of an address, lowercased.
 *
 * Case matters here and nowhere else. RFC 5321 makes the local part
 * case-SENSITIVE, so `Ada@example.com` is formally a different mailbox from
 * `ada@example.com` and the address is sent exactly as given. But no real
 * provider honours that, which means `AdA@`, `aDa@`… are the same inbox and an
 * unfolded rate-limit key is a mailbombing bypass with no tooling required.
 * The key folds; the envelope does not.
 */
export function rateLimitIdentity(address: EmailAddress): string {
  return address.toLowerCase();
}

/**
 * The domain half, for logs. The full address is personal data and does not
 * belong in CloudWatch (Governance §11.6); the domain plus the provider's
 * message id is what an incident actually needs to trace a delivery.
 */
export function addressDomain(address: EmailAddress): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}
