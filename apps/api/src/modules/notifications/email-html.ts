/**
 * The HTML half of a transactional email, rendered FROM the plain-text body.
 *
 * ## The drift rule, which is the whole design
 *
 * This module never composes copy. It takes the exact plain-text body a
 * reviewer approved (`email-copy.ts`, whose header explains why there is one
 * composition and only one) and re-renders those same words in the product's
 * shell — so the HTML part and the text part of a message cannot say different
 * things, because one is derived from the other at send time. Anything this
 * file cannot render it renders as a plain paragraph; it never drops a line.
 *
 * ## What was reversed here, and on whose word (28 Aug 2026)
 *
 * `email-sender.ts` shipped plain-text-only, argued from deliverability: a
 * transactional message that looks like a campaign is scored as one. Mubasshir
 * directed the product to send professionally designed HTML (the shape of
 * Anthropic's own sign-in mails), so the constraint moved rather than died —
 * the HTML below is built to keep every property the plain-text argument was
 * actually protecting:
 *
 * - **No remote resources at all.** No image, no logo fetch, no webfont, no
 *   tracking pixel. The wordmark is styled text. Zero external requests is
 *   also what image-blocking clients render anyway.
 * - **The text part stays authoritative and complete** — multipart/alternative
 *   with nothing HTML-only. A client that strips HTML loses styling, never
 *   content. Sign-in codes live in both parts, in body text, never in a link.
 * - **Table layout, inline styles only** — renders in Outlook, Gmail clipping
 *   stays distant (the shell is ~3 kB), and there is no <style> block for a
 *   client to mangle.
 *
 * Flagged for Shakib with the rest of the 28 Aug batch: this reverses a
 * documented stance in `email-sender.ts` and the module CLAUDE.md, and S7's
 * deliverability walkthrough should re-verify inbox placement with the HTML
 * part attached before it rides to production.
 */

/** The web `--color-brand` fill (apps/web/src/index.css) — mint in both themes. */
const BRAND = '#14e3c4';
/** Dark ink for text ON the mint — white on mint is 1.4:1 (the web's text-brand-on argument). */
const BRAND_INK = '#04332b';
const INK = '#26302e';
const INK_SOFT = '#6b7674';
const CARD_BORDER = '#e6e9e8';
const CODE_BG = '#f0faf8';
const CODE_BORDER = '#b8efe5';
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface EmailHtmlInput {
  /** Used for the document <title> only. Never carries a credential (email-copy rule 1). */
  readonly subject: string;
  /** The plain-text body — the single source this render derives from. */
  readonly body: string;
  /**
   * A credential rendered as the large code box (the sign-in code). The line
   * containing it splits into label + box; the code itself is still body text
   * in the text part, this only styles it here.
   */
  readonly highlight?: string;
  /** URL → button label. A body line that IS that URL renders as a button with the bare link beneath it for copy-paste. */
  readonly linkLabels?: Readonly<Record<string, string>>;
}

export function renderEmailHtml(input: EmailHtmlInput): string {
  const lines = input.body.replace(/\n$/, '').split('\n');
  const blocks: string[] = [];
  let bullets: string[] = [];

  const flushBullets = (): void => {
    if (bullets.length === 0) return;
    const rows = bullets
      .map(
        (item) =>
          `<tr><td style="padding:4px 0 4px 2px;color:${INK};font-size:15px;line-height:1.6;font-family:${FONT};">` +
          `<span style="color:${BRAND};font-weight:700;">&bull;</span>&nbsp;&nbsp;${escapeHtml(item)}</td></tr>`,
      )
      .join('');
    blocks.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;">${rows}</table>`);
    bullets = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
      continue;
    }
    flushBullets();

    if (input.highlight !== undefined && line.includes(input.highlight)) {
      blocks.push(codeBlock(line, input.highlight));
      continue;
    }
    if (/^https?:\/\/\S+$/.test(line)) {
      blocks.push(linkBlock(line, input.linkLabels?.[line]));
      continue;
    }
    blocks.push(
      `<p style="margin:14px 0;color:${INK};font-size:15px;line-height:1.6;font-family:${FONT};">${escapeHtml(line)}</p>`,
    );
  }
  flushBullets();

  return shell(input.subject, blocks.join('\n'));
}

/** "Your sign-in code is 123456" → the label as small text, the code as the box. */
function codeBlock(line: string, code: string): string {
  const label = line.replace(code, '').replace(/\s+/g, ' ').trim();
  return (
    `<div style="text-align:center;margin:22px 0;">` +
    (label === ''
      ? ''
      : `<p style="margin:0 0 10px;color:${INK_SOFT};font-size:13px;font-family:${FONT};">${escapeHtml(label)}</p>`) +
    `<div style="display:inline-block;padding:14px 28px;background:${CODE_BG};border:1px solid ${CODE_BORDER};border-radius:10px;` +
    `color:#0f1720;font-size:28px;font-weight:700;letter-spacing:8px;font-family:${FONT};">${escapeHtml(code)}</div>` +
    `</div>`
  );
}

/** A URL-only line → a button when labelled, always with the bare link visible for copy-paste. */
function linkBlock(url: string, label: string | undefined): string {
  const href = escapeHtml(url);
  const bare = `<p style="margin:8px 0 14px;font-size:12px;line-height:1.5;font-family:${FONT};word-break:break-all;">` +
    `<a href="${href}" style="color:${INK_SOFT};">${href}</a></p>`;
  if (label === undefined) {
    return `<p style="margin:14px 0;font-size:15px;line-height:1.6;font-family:${FONT};word-break:break-all;"><a href="${href}" style="color:#0b8a76;font-weight:600;">${href}</a></p>`;
  }
  return (
    `<div style="text-align:center;margin:22px 0 6px;">` +
    `<a href="${href}" style="display:inline-block;padding:12px 28px;background:${BRAND};color:${BRAND_INK};` +
    `font-size:15px;font-weight:700;text-decoration:none;border-radius:999px;font-family:${FONT};">${escapeHtml(label)}</a>` +
    `</div>` +
    `<div style="text-align:center;">${bare}</div>`
  );
}

function shell(subject: string, inner: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f6f5;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f5;padding:28px 12px;"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">` +
    // The mint accent bar, then the card.
    `<tr><td style="height:4px;background:${BRAND};border-radius:4px 4px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>` +
    `<tr><td style="background:#ffffff;border:1px solid ${CARD_BORDER};border-top:0;border-radius:0 0 12px 12px;padding:32px 36px;">` +
    // The wordmark is TEXT — no image, nothing fetched, nothing blocked.
    `<p style="margin:0 0 20px;font-size:17px;font-family:${FONT};color:#0f1720;">` +
    `<span style="font-weight:800;">Neo</span><span style="font-weight:400;">&nbsp;Accounting</span></p>` +
    inner +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
