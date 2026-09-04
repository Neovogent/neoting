/**
 * Build the invoice test set: the ground-truth map first, then the documents.
 *
 *   pnpm tsx scripts/demo/invoice-test-set/generate.ts
 *
 * Writes to `~/Downloads/neoting-invoice-test-set/`. PDFs are rendered here and
 * are exact. The IMAGE documents are only *specified* here — `images.ts` calls
 * `gpt-image-2` for those, and then reads each one back with a vision model to
 * record what the picture ACTUALLY says, because an image model's rendering of
 * "£1,568.38" is a hope, not a guarantee.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BUSINESS, SUPPLIERS, type StatementRow, type TestDoc } from './plan.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STATEMENT_CSV = resolve('scripts/demo/bank-statement/out/statement.csv');
export const OUT = join(homedir(), 'Downloads', 'neoting-invoice-test-set');
const DOCS = join(OUT, 'documents');

/* ── The statement, as the source of truth ────────────────────────────────── */

function loadStatement(): StatementRow[] {
  const text = readFileSync(STATEMENT_CSV, 'utf8');
  const lines = text.split(/\r?\n/);
  const headerAt = lines.findIndex((l) => l.startsWith('Date,'));
  if (headerAt === -1) throw new Error('No header row in the statement CSV.');

  const rows: StatementRow[] = [];
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const cells = splitCsv(lines[i] ?? '');
    if (cells.length < 5 || cells[0] === '') continue;
    const out = cells[2] ?? '';
    const inn = cells[3] ?? '';
    if (out === '' && inn === '') continue; // the brought-forward line
    const pence = out !== '' ? -toPence(out) : toPence(inn);
    rows.push({ line: i + 1, date: cells[0] ?? '', description: cells[1] ?? '', pence });
  }
  return rows;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const toPence = (s: string): number => Math.round(Number.parseFloat(s.replace(/,/g, '')) * 100);

/* ── Selection helpers ────────────────────────────────────────────────────── */

const all = loadStatement();

/** The Nth (0-based) occurrence of a narrative, so a pick is reproducible. */
function pick(match: string, nth = 0): StatementRow {
  const hits = all.filter((r) => r.description.includes(match));
  const row = hits[nth];
  if (row === undefined) throw new Error(`No row ${nth} matching "${match}" (found ${hits.length}).`);
  return row;
}

/** Every occurrence within the given `MM/YYYY` months. */
function slice(match: string, months: string[]): StatementRow[] {
  const set = new Set(months);
  const rows = all.filter((r) => r.description.includes(match) && set.has(r.date.slice(3)));
  if (rows.length === 0) throw new Error(`No rows for "${match}" in ${months.join(', ')}`);
  return rows;
}

/** How many statement lines carry this exact amount — the ambiguity measure. */
function sameAmountCount(pence: number): number {
  return all.filter((r) => r.pence === pence).length;
}

/* ── The document set ─────────────────────────────────────────────────────── */

function doc(
  id: string,
  format: TestDoc['format'],
  shape: TestDoc['shape'],
  supplierKey: keyof typeof SUPPLIERS,
  reference: string,
  termsDays: number,
  rows: StatementRow[],
  extra: Partial<Pick<TestDoc, 'expectNoMatch' | 'notes'>> = {},
): TestDoc {
  const s = SUPPLIERS[supplierKey];
  if (s === undefined) throw new Error(`Unknown supplier ${String(supplierKey)}`);
  const ambiguous = rows.length === 1 && rows[0] !== undefined && sameAmountCount(rows[0].pence) > 1;
  return {
    id,
    format,
    shape,
    supplier: s.name,
    supplierAddress: s.address,
    reference,
    termsDays,
    vatRate: s.vatRate,
    vatNumber: s.vat,
    rows,
    ambiguousAmount: ambiguous,
    expectNoMatch: extra.expectNoMatch ?? null,
    notes: extra.notes ?? '',
  };
}

export function buildDocs(): TestDoc[] {
  const worldpayMar = slice('WORLDPAY SETTLEMENT', ['03/2026']);
  const bidfoodQ = slice('BIDFOOD', ['02/2026', '03/2026', '04/2026']);
  const valeQ = slice('VALE FRESH', ['02/2026', '03/2026', '04/2026']);
  const aldgateQ = slice('ALDGATE', ['02/2026', '03/2026', '04/2026']);
  const bakeQ = slice('BARCHESTER BAKEHOUSE', ['02/2026', '03/2026', '04/2026']);

  const a1Row = pick('BACS BIDFOOD UK', 0);
  const heritageReal = pick('HERITAGE CRAFT BEERS', 0);

  return [
    /* A · one transaction, PDF — the baseline. Unique amounts, easy. */
    doc('A1', 'pdf', 'invoice', 'bidfood', 'BF-2025-884213', 21, [a1Row], {
      notes: 'Baseline. Unique amount, clear supplier, ordinary 21-day terms.',
    }),
    doc('A2', 'pdf', 'invoice', 'biffa', 'BIF-4471902', 14, [pick('DD BIFFA WASTE SVCS', 0)], {
      notes: 'Direct debit. Invoice precedes collection.',
    }),
    doc('A3', 'pdf', 'invoice', 'britishgas', '7734-002918-4', 14, [pick('DD BRITISH GAS LITE', 0)], {
      notes: 'Utility bill; the amount changes every month, so it is unique.',
    }),
    doc('A4', 'pdf', 'invoice', 'rentokil', 'RTK-559034', 12, [pick('DD RENTOKIL PEST CTRL', 0)], {
      notes:
        'HARD. £95.00 is billed 13 times across the year at the same amount. ' +
        'Amount alone cannot identify the line — only the date can.',
    }),
    doc('A5', 'pdf', 'invoice', 'cocacola', 'CCEP-30028841', 30, [pick('BACS COCA-COLA EUROPACIFIC', 0)], {
      notes: '30-day terms — the widest gap between document date and payment.',
    }),

    /* B · one transaction, IMAGE (gpt-image-2). */
    doc('B1', 'image', 'invoice', 'aldgate', 'AM-77120', 7, [pick('ALDGATE MEATS', 0)], {
      notes: 'Photographed invoice. Round amount (£994.00) — check it is not confused with a near neighbour.',
    }),
    doc('B2', 'image', 'invoice', 'valefresh', 'VFP-20451', 7, [pick('VALE FRESH PRODUCE', 0)], {
      notes: 'Photographed produce invoice, zero-rated.',
    }),
    doc('B3', 'image', 'invoice', 'navitas', 'NAV-8842', 10, [pick('DD NAVITAS SAFETY', 0)], {
      notes: 'HARD. £59.00 recurs 13 times. Date is the only discriminator.',
    }),
    doc('B4', 'image', 'handwritten-receipt', 'window', '—', 0, [pick('B C WINDOW CLEANING', 0)], {
      notes:
        'HARD + adversarial. £35.00 recurs 13 times, AND it is a hand-written jobbing ' +
        'receipt with no VAT number and no printed reference — the worst legibility case in the set.',
    }),

    /* C · more than 10 transactions in ONE document, PDF. */
    doc('C1', 'pdf', 'settlement-statement', 'worldpay', 'WP-SETL-2026-03', 0, worldpayMar, {
      notes:
        `${worldpayMar.length} daily card settlements for March 2026. These are CREDITS — money IN. ` +
        'A matcher that assumes a document evidences a payment out will fail the whole schedule.',
    }),
    doc('C2', 'pdf', 'supplier-statement', 'bidfood', 'BF-STMT-2026-Q1', 0, bidfoodQ, {
      notes: `${bidfoodQ.length} invoices settled individually across three months. Must fan out, not match once on the total.`,
    }),
    doc('C3', 'pdf', 'supplier-statement', 'valefresh', 'VFP-STMT-0426', 0, valeQ, {
      notes: `${valeQ.length} small produce invoices. Amounts are close together, which makes mis-pairing easy.`,
    }),

    /* D · more than 10 transactions in ONE IMAGE. */
    doc('D1', 'image', 'supplier-statement', 'aldgate', 'AM-STMT-0426', 0, aldgateQ, {
      notes: `${aldgateQ.length} lines in a photographed statement — the hardest realistic OCR case in the set.`,
    }),
    doc('D2', 'image', 'supplier-statement', 'bakehouse', 'BBH-STMT-0426', 0, bakeQ, {
      notes: `${bakeQ.length} lines, small amounts, photographed.`,
    }),

    /* E · negative controls. Nothing here should match anything. */
    doc('E1', 'pdf', 'invoice', 'thornbury', 'TCS-11284', 21, [], {
      expectNoMatch: {
        why: 'supplier-absent',
        detail: 'Thornbury Catering Supplies appears nowhere in the statement, and £742.19 is paid to nobody.',
      },
      notes: 'CONTROL. A real-looking invoice for a payment that was never made.',
    }),
    doc('E2', 'image', 'invoice', 'heritage', 'HCB-6621', 14, [], {
      expectNoMatch: {
        why: 'amount-near-miss',
        detail:
          `The statement has HERITAGE CRAFT BEERS at £${(Math.abs(heritageReal.pence) / 100).toFixed(2)} on ` +
          `${heritageReal.date} (line ${heritageReal.line}). This invoice is for £407.75 — 18p different. ` +
          'It must NOT be matched to it.',
      },
      notes: 'CONTROL, and the sharpest one. Right supplier, right period, wrong amount by 18p.',
    }),
    doc('E3', 'pdf', 'invoice', 'bakehouse', 'BBH-90114', 0, [], {
      expectNoMatch: {
        why: 'out-of-period',
        detail: 'Dated 15/09/2026, after the statement period ends on 31/08/2026. There is no line it could match.',
      },
      notes: 'CONTROL. Correct supplier, plausible amount, but outside the statement entirely.',
    }),
    doc('E4', 'pdf', 'invoice', 'bidfood', 'BF-2025-884213', 21, [a1Row], {
      expectNoMatch: {
        why: 'duplicate-of',
        detail:
          'A byte-for-byte re-issue of A1 — same invoice number, same amount, same date. It must resolve to the ' +
          'SAME single transaction as A1, and must NOT consume a second bank line.',
      },
      notes: 'CONTROL for de-duplication rather than for matching.',
    }),
  ];
}

/* ── Money ────────────────────────────────────────────────────────────────── */

/** Gross → {net, vat}, integer pence, summing back to gross EXACTLY. */
export function splitVat(grossPence: number, rate: 0 | 20): { net: number; vat: number } {
  if (rate === 0) return { net: grossPence, vat: 0 };
  const net = Math.round(grossPence / 1.2);
  return { net, vat: grossPence - net };
}

export const money = (pence: number): string =>
  `${(Math.abs(pence) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** `DD/MM/YYYY` minus n days, still `DD/MM/YYYY`. */
export function minusDays(uk: string, days: number): string {
  const [d, m, y] = uk.split('/').map((n) => Number.parseInt(n, 10));
  const t = Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1) - days * 86_400_000;
  const dt = new Date(t);
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

/**
 * Split a net total into believable line items that sum to it EXACTLY.
 * The last item absorbs the remainder, so the arithmetic on the page is right.
 */
export function lineItems(netPence: number, catalogue: readonly string[], seed: number): { desc: string; pence: number }[] {
  const n = Math.min(catalogue.length, 2 + (seed % 3));
  const items: { desc: string; pence: number }[] = [];
  let left = netPence;
  for (let i = 0; i < n - 1; i += 1) {
    const share = Math.round((netPence / n) * (0.7 + ((seed >> (i * 3)) % 60) / 100));
    const take = Math.max(1, Math.min(share, left - (n - 1 - i)));
    items.push({ desc: catalogue[(seed + i) % catalogue.length] ?? 'Goods', pence: take });
    left -= take;
  }
  items.push({ desc: catalogue[(seed + n) % catalogue.length] ?? 'Goods', pence: left });
  return items;
}

export const CATALOGUE: Record<string, string[]> = {
  'Bidfood UK Ltd': ['Frozen beef patties 4oz, case of 48', 'Brioche buns, case of 60', 'Skin-on fries 2.5kg x6', 'Streaky bacon 2kg', 'Cheese slices, 1kg'],
  'Aldgate Meats Ltd': ['Chuck & brisket mince 20kg', 'Beef short rib, 10kg', 'Chicken thigh fillet 10kg', 'Pulled pork shoulder 8kg'],
  'Vale Fresh Produce Ltd': ['Beef tomatoes, 5kg', 'Iceberg lettuce x12', 'Red onions, 10kg', 'Gherkins, 5L pail', 'Baby gem x24'],
  'Barchester Bakehouse Ltd': ['Brioche burger buns x120', 'Seeded buns x60', 'Gluten-free buns x24'],
  'Biffa Waste Services Ltd': ['1100L general waste, weekly collection', 'Dry mixed recycling, fortnightly', 'Food waste 240L, weekly'],
  'British Gas Lite': ['Electricity supply — standing charge', 'Electricity supply — unit charge', 'Gas supply — unit charge'],
  'Rentokil Pest Control': ['Pest control service visit — monthly contract'],
  'Coca-Cola Europacific Partners': ['Coca-Cola 330ml x24', 'Diet Coke 330ml x24', 'Fanta Orange 330ml x24', 'Sprite 330ml x24'],
  'Navitas Safety Ltd': ['Food safety management system — monthly licence'],
  'B C Window Cleaning': ['Shopfront window clean — exterior'],
  'Heritage Craft Beers Ltd': ['Pale ale 330ml x24', 'Session IPA 330ml x24', 'Lager 330ml x24'],
  'Worldpay (UK) Limited': ['Card processing charges'],
  'Thornbury Catering Supplies Ltd': ['Catering disposables — assorted', 'Kitchen chemicals — assorted', 'Blue roll, case of 6'],
};

/* ── Chrome ───────────────────────────────────────────────────────────────── */

/**
 * Prints HTML with headless Chrome. Two workarounds, both load-bearing —
 * see `scripts/demo/bank-statement/generate.ts`, which learned them the hard way:
 * `--user-data-dir` or a running Chrome answers the launch and nothing is
 * written; and Chrome 152 headless never exits, so completion is judged from a
 * stable file with a `%%EOF` trailer rather than from an exit code.
 */
export function printPdf(htmlPath: string, pdfPath: string): void {
  if (!existsSync(CHROME)) throw new Error(`Google Chrome not found at ${CHROME}.`);
  rmSync(pdfPath, { force: true });
  const profile = mkdtempSync(join(tmpdir(), 'nt-inv-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: 'ignore', detached: true },
  );
  try {
    const deadline = Date.now() + 120_000;
    let lastSize = -1;
    let stable = 0;
    while (Date.now() < deadline) {
      execFileSync('/bin/sleep', ['0.4']);
      if (!existsSync(pdfPath)) continue;
      const size = statSync(pdfPath).size;
      stable = size === lastSize && size > 0 ? stable + 1 : 0;
      lastSize = size;
      if (stable >= 2 && endsWithEof(pdfPath)) return;
    }
    throw new Error(`Chrome did not finish ${pdfPath} in 120s.`);
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

function endsWithEof(path: string): boolean {
  const size = statSync(path).size;
  if (size < 8) return false;
  const fd = openSync(path, 'r');
  try {
    const tail = Buffer.alloc(Math.min(64, size));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    return tail.toString('latin1').trimEnd().endsWith('%%EOF');
  } finally {
    closeSync(fd);
  }
}

export { all as STATEMENT_ROWS, DOCS, mkdirSync, writeFileSync, BUSINESS };
