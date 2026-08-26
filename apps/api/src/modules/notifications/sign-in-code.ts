/**
 * The six-digit sign-in code, in a wrapper that refuses to reveal itself.
 *
 * S2's rule, verbatim: *"The code is a CREDENTIAL. Never log it, never put it
 * in a URL, never return it in an API response or an error, not even in
 * development."* A comment saying that is worth very little — the leak is never
 * deliberate. It is a `logger.log(\`otp ${input}\`)` added while debugging, a
 * `JSON.stringify(payload)` in an error handler, an exception whose `cause`
 * carries the whole input object into an alert.
 *
 * So the rule is made structural instead. Every path by which a value
 * accidentally becomes text is overridden to produce {@link REDACTED}:
 *
 * | Path | What it yields |
 * |---|---|
 * | `` `${code}` ``, `String(code)`, string concatenation | `[sign-in code]` |
 * | `JSON.stringify({ code })` | `"[sign-in code]"` |
 * | `util.inspect(code)`, which is what Nest's `Logger` uses on an object | `[sign-in code]` |
 *
 * The value leaves by exactly one door, {@link SignInCode.reveal}, named so
 * that `grep -rn 'reveal()'` enumerates every place in the codebase where the
 * code becomes a string. There is one: the body of the email it exists to be
 * carried in.
 *
 * The field is a true `#private`, not TypeScript's compile-time `private` — a
 * `private` field is an ordinary enumerable property at runtime, so
 * `JSON.stringify` and `util.inspect` would both print it and every guarantee
 * above would be decorative.
 */

/** What the code renders as everywhere except the email body itself. */
export const REDACTED = '[sign-in code]';

/** Six digits. The shape `OtpSession.otp_hash` is a hash of, and the contract's. */
const CODE_SHAPE = /^[0-9]{6}$/;

export class SignInCode {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  /**
   * Parse or throw. A code that is not six digits is a caller bug — the
   * generator is ours — and a bug here must not be smoothed over into an email
   * that tells a client to type something that will never verify.
   */
  static parse(raw: string): SignInCode {
    if (!CODE_SHAPE.test(raw)) {
      // Note what this message does NOT contain: the offending value. An
      // invalid-code error is exactly the kind of thing that gets logged.
      throw new Error('a sign-in code must be exactly six digits');
    }
    return new SignInCode(raw);
  }

  /**
   * The only reader. Call it at the point the code is written into the email
   * body and nowhere else — a `reveal()` anywhere but `email-copy.ts` is a
   * finding, and this name exists to make that grep possible.
   */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /**
   * `util.inspect`'s hook. Nest's `Logger` inspects objects rather than
   * stringifying them, so without this a code passed inside a log context
   * object would print as `SignInCode {}` today and as the value itself the
   * day Node starts showing private fields (it has changed its mind about
   * this before). Pinned rather than trusted.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
