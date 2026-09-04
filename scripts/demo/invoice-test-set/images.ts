/**
 * The IMAGE half of the test set — `gpt-image-2` on Azure AI Foundry.
 *
 *   pnpm tsx scripts/demo/invoice-test-set/images.ts
 *
 * ## Why every image is read back afterwards
 *
 * An image model DRAWS text; it does not typeset it. Asked for `£1,568.38` it
 * may produce `£1,568.88`, and for a 13-row table it may drop or invent a line.
 * That matters more here than it usually would: the whole point of the set is
 * that the ground truth is exact, and a map that records what the model was
 * ASKED to draw would be a map of a document that does not exist.
 *
 * So each generated image is sent straight back to a vision model, transcribed,
 * and compared against the spec. `IMAGE-FIDELITY.md` records the verdict per
 * document — `faithful`, or the specific values that came out different. Where
 * an amount drifted, the document is reclassified in that report, because an
 * invoice for an amount no bank line carries is a negative control whether or
 * not it was meant to be one.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT = join(homedir(), 'Downloads', 'neoting-invoice-test-set');
const SPECS = join(OUT, '.work', 'image-specs.json');
const IMAGES = join(OUT, 'documents', 'images');

/**
 * Both the endpoint and the key come from the environment — the resource name
 * is infrastructure and does not belong in a committed file any more than the
 * key does. `ANTHROPIC_FOUNDRY_BASE_URL` points at the Anthropic passthrough
 * (`…/anthropic`); the OpenAI-shaped image route hangs off the same root.
 */
const BASE = process.env['ANTHROPIC_FOUNDRY_BASE_URL'] ?? '';
const KEY = process.env['ANTHROPIC_FOUNDRY_API_KEY'] ?? '';
if (BASE === '' || KEY === '') {
  throw new Error('ANTHROPIC_FOUNDRY_BASE_URL and ANTHROPIC_FOUNDRY_API_KEY must be set — source ~/.claude-foundry.env');
}
const ROOT = BASE.replace(/\/anthropic\/?$/, '');

const IMAGE_URL = `${ROOT}/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview`;
const VISION_URL = `${ROOT}/anthropic/v1/messages`;

interface Spec {
  id: string;
  fileName: string;
  shape: string;
  supplier: string;
  supplierAddress: string[];
  vatNumber: string | null;
  reference: string;
  docDate: string;
  netPence: number;
  vatPence: number;
  grossPence: number;
  vatRate: number;
  rows: { line: number; date: string; description: string; pence: number }[];
  items: { desc: string; pence: number }[];
}

const money = (p: number): string =>
  (Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ── Prompts ──────────────────────────────────────────────────────────────── */

/**
 * The prompt states every string that must appear, verbatim and in a list.
 * Describing the document loosely and hoping the numbers land is how you get a
 * beautiful invoice for the wrong amount.
 */
function promptFor(s: Spec): string {
  const zero = s.vatRate === 0;

  if (s.shape === 'handwritten-receipt') {
    return [
      'A photograph of a small hand-written UK tradesman receipt on a duplicate-book page,',
      'lying on a wooden counter, shot from above with a phone. Slight shadow, very slightly',
      'angled, realistic paper texture with faint blue carbon lines. The handwriting is in blue',
      'biro, neat but clearly hand-written, and fully legible.',
      '',
      'The receipt must contain EXACTLY this text, hand-written, and nothing that contradicts it:',
      `  Business name at the top: "${s.supplier}"`,
      `  Below it: "${s.supplierAddress.join(', ')}"`,
      `  "Date: ${s.docDate}"`,
      `  "To: American Burger Ltd, 42 Bridge Street, Barchester"`,
      '  Description line: "Shopfront window clean - exterior"',
      `  A large total at the bottom: "TOTAL  £${money(s.grossPence)}"`,
      '  "Paid with thanks"',
      '',
      'No VAT number and no printed invoice number — this is an informal receipt.',
      'Every digit must be crisp and unambiguous. Do not add any other numbers.',
    ].join('\n');
  }

  if (s.shape === 'supplier-statement') {
    const lines = s.rows
      .map((r, i) => `    "${r.date}"  |  "INV-${60_000 + i * 137}"  |  "£${money(r.pence)}"`)
      .join('\n');
    return [
      'A photograph of a printed UK supplier STATEMENT OF ACCOUNT lying flat on a desk,',
      'taken from directly above with a phone camera in even office light. The paper is white',
      'A4, crisp laser print, very slightly rotated, with a soft natural shadow along one edge.',
      'The whole page is in frame and every line of the table is sharp and readable.',
      '',
      `Letterhead, bold, top left: "${s.supplier}"`,
      `Under it in small grey type: "${s.supplierAddress.join(', ')}"`,
      s.vatNumber ? `And: "VAT Reg. No. ${s.vatNumber}"` : '',
      'Top right, large: "STATEMENT"',
      `Under it: "${s.reference}" and "Date: ${s.docDate}"`,
      'Left block: "Account: American Burger Ltd, 42 Bridge Street, Barchester, BA1 2QN"',
      '',
      `A table with column headings "Date", "Invoice no.", "Amount" and EXACTLY ${s.rows.length} rows,`,
      'in this order, with these exact values:',
      lines,
      '',
      `A bold total row at the bottom: "Total due   £${money(s.grossPence)}"`,
      '',
      'CRITICAL: reproduce every date and every amount exactly as listed, digit for digit.',
      `There must be exactly ${s.rows.length} data rows — no more, no fewer, none invented.`,
      'Do not add a VAT line. Do not round any figure.',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  const items = s.items.map((it) => `    "${it.desc}"  |  "£${money(it.pence)}"`).join('\n');
  return [
    'A photograph of a printed UK supplier INVOICE lying flat on a desk, taken from directly',
    'above with a phone camera in even daylight. White A4 paper, crisp laser print, very',
    'slightly rotated with a soft shadow down one side. The entire page is in frame, in focus,',
    'and every character is sharp and legible.',
    '',
    `Letterhead, bold, top left: "${s.supplier}"`,
    `Beneath in small grey type: "${s.supplierAddress.join(', ')}"`,
    s.vatNumber ? `And beneath that: "VAT Reg. No. ${s.vatNumber}"` : '',
    'Top right, large and bold: "INVOICE"',
    `Under it: "${s.reference}" and "Date: ${s.docDate}"`,
    'Left block headed "Invoice to": "American Burger Ltd, 42 Bridge Street, Barchester, Wessex, BA1 2QN, VAT GB334455667"',
    '',
    'A line-item table with headings "Description", "Qty", "Amount" containing exactly these rows:',
    items,
    '',
    'Then a totals block on the right, exactly:',
    zero
      ? `    "Total (zero-rated)   £${money(s.netPence)}"\n    "Total due   £${money(s.grossPence)}"`
      : `    "Subtotal   £${money(s.netPence)}"\n    "VAT @ 20%   £${money(s.vatPence)}"\n    "Total due   £${money(s.grossPence)}"`,
    '',
    'CRITICAL: every amount must be reproduced exactly, digit for digit, including the pence.',
    'Do not invent extra line items and do not alter any figure.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/* ── Calls ────────────────────────────────────────────────────────────────── */

async function generate(spec: Spec): Promise<Buffer> {
  const res = await fetch(IMAGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': KEY },
    body: JSON.stringify({
      prompt: promptFor(spec),
      n: 1,
      size: '1024x1536',
      quality: 'high',
    }),
  });
  if (!res.ok) throw new Error(`gpt-image-2 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { data: { b64_json?: string; url?: string }[] };
  const first = body.data[0];
  if (first?.b64_json === undefined) throw new Error('No b64_json in the image response.');
  return Buffer.from(first.b64_json, 'base64');
}

/** Read the picture back. The model is a boundary — this is a transcription, not a judgement. */
async function transcribe(png: Buffer): Promise<string> {
  const res = await fetch(VISION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 3000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
            {
              type: 'text',
              text:
                'Transcribe this document exactly as printed. List the supplier name, the document ' +
                'reference, the document date, every table row (date, reference, description, amount), ' +
                'and every total. Copy the digits exactly as they appear — do not correct, round or ' +
                'infer anything. If a value is unreadable, write UNREADABLE.',
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) return `TRANSCRIPTION FAILED ${res.status}`;
  const body = (await res.json()) as { content: { type: string; text?: string }[] };
  return body.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
const specs = JSON.parse(readFileSync(SPECS, 'utf8')) as Spec[];
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const todo = only.length > 0 ? specs.filter((s) => only.includes(s.id)) : specs;

const report: string[] = [
  '# Image fidelity — what `gpt-image-2` actually drew',
  '',
  'An image model draws text rather than typesetting it, so the values on these',
  'pictures are not guaranteed to be the values requested. Each image below was',
  'sent back to a vision model and transcribed, and the transcription compared',
  'against the specification.',
  '',
  '**Where an amount came out different, the ground truth for that document is the',
  'amount ON THE IMAGE, not the one in `GROUND-TRUTH.md`** — and a document whose',
  'total drifted no longer evidences its bank line, so it becomes a negative',
  'control in practice. Each verdict below says which case applies.',
  '',
];

for (const spec of todo) {
  const path = join(IMAGES, spec.fileName);
  process.stdout.write(`${spec.id} … `);
  try {
    const png = existsSync(path) && process.argv.includes('--reuse') ? readFileSync(path) : await generate(spec);
    writeFileSync(path, png);
    process.stdout.write(`drawn (${(png.length / 1024).toFixed(0)} KB) … `);

    const text = await transcribe(png);
    const wantGross = `£${money(spec.grossPence)}`;
    const grossOk = text.includes(money(spec.grossPence));
    const rowsWanted = spec.rows.map((r) => money(r.pence));
    const rowsFound = rowsWanted.filter((m) => text.includes(m));
    const refOk = spec.reference === '—' || text.includes(spec.reference);

    // ⚠ A failed read is NOT a failed image. Transcription is a network call to a
    // metered model and it can 429; reporting that as "the image is wrong" would
    // condemn a perfectly good document on the strength of our own rate limit.
    // Those two outcomes must never collapse into one verdict.
    const unverified = text.startsWith('TRANSCRIPTION FAILED');
    const verdict = unverified
      ? `UNVERIFIED — could not read the image back (${text}). The picture exists and may well be correct; nothing here proves it either way.`
      : grossOk && rowsFound.length === rowsWanted.length
        ? 'FAITHFUL'
        : grossOk
          ? `PARTIAL — total correct, ${rowsWanted.length - rowsFound.length} of ${rowsWanted.length} row amounts differ`
          : 'DRIFTED — the total on the image is not the requested total';

    console.log(verdict);
    report.push(
      `## ${spec.id} — ${spec.supplier}`,
      '',
      `- **File:** \`documents/images/${spec.fileName}\``,
      `- **Requested total:** ${wantGross} — **${unverified ? 'not checked' : grossOk ? 'present on the image' : 'NOT FOUND on the image'}**`,
      `- **Requested reference:** ${spec.reference} — ${unverified ? 'not checked' : refOk ? 'present' : 'not found'}`,
      spec.rows.length > 0 && !unverified
        ? `- **Row amounts:** ${rowsFound.length} of ${rowsWanted.length} found in the transcription`
        : spec.rows.length > 0
          ? `- **Row amounts:** not checked (${rowsWanted.length} expected)`
          : '- **Row amounts:** n/a (single-transaction document)',
      `- **Verdict: ${verdict}**`,
      '',
      '<details><summary>Transcription</summary>',
      '',
      '```',
      text.slice(0, 4000),
      '```',
      '',
      '</details>',
      '',
    );
  } catch (error) {
    console.log(`FAILED — ${(error as Error).message}`);
    report.push(`## ${spec.id} — ${spec.supplier}`, '', `- **FAILED:** ${(error as Error).message}`, '');
  }
}

writeFileSync(join(OUT, 'IMAGE-FIDELITY.md'), report.join('\n'), 'utf8');
console.log(`\nfidelity report → ${join(OUT, 'IMAGE-FIDELITY.md')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
