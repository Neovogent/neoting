/**
 * Reduce a submitter-controlled filename to a bare basename — never a path.
 *
 * `../../etc/passwd` → `passwd`, `C:\evil\x.pdf` → `x.pdf`. Every channel takes
 * a name from someone outside the system: an email part's `Content-Disposition`,
 * a WhatsApp `document.filename`, a portal upload. It is kept for display and
 * metadata only and is NEVER trusted for the file's type — magic-byte sniffing
 * is the sole authority on that.
 *
 * Shared rather than copied: two channels reducing an attacker-controlled name
 * two slightly different ways is how one of them ends up not reducing it.
 */
export function safeBasename(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').trim();
  return base === '' || base === '.' || base === '..' ? 'attachment' : base;
}
