/**
 * Measure what one document actually costs to read (launch stage S5, item 4).
 *
 * ## Why this is a script and not a number in a document
 *
 * `extraction/CLAUDE.md` carried "~7 s, ~$0.016/document" for six days with a
 * warning attached: the figure was taken on a different, unpinned model, and
 * `models.ts` has been repinned since. A cost figure with no way to re-take it
 * decays into folklore — it gets quoted in a pricing conversation long after the
 * model, the prompt or the tool schema moved underneath it. The same reasoning
 * as `docs/runbooks/stripe-billing.md` §4, which writes down the VAT probe so it
 * can be re-run after any change to the price.
 *
 * Re-run this whenever `TASKS.extractionVisionFirst`, `MODELS`, the system
 * prompt or `EXTRACTION_TOOL_SCHEMA` changes.
 *
 * ## What it measures
 *
 * The REAL `BedrockExtractor` — the production class, its real system prompt,
 * its real forced tool call, the model pinned in `chat-framework/models.ts` —
 * against two documents shaped like the ones §24.7 names: a photographed receipt
 * and a born-digital supplier invoice as a PDF. The only stand-in is the
 * `DocumentStore`, which hands over bytes from memory instead of S3; that
 * changes latency by a few milliseconds and the token count not at all.
 *
 * The tokens it reports are the ones the meter bills, read from the same
 * `usage` block `BedrockExtractor.record` uses, priced through the same
 * `costPence` from the same rate table. So this measures the number that will
 * actually land on a practice's daily ledger, not an approximation of it.
 *
 * ## Running it
 *
 *   AWS_PROFILE=nt pnpm tsx scripts/measure/extraction-cost.ts
 *
 * It spends real money — two model calls, well under a penny — against whatever
 * account the AWS credentials in the environment resolve to. It writes nothing
 * to a database and needs no local services.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import sharp from 'sharp';

import { InMemoryAiBudget } from '../../apps/api/src/common/ai-budget.js';
import { costPence, MODELS, TASKS } from '../../apps/api/src/modules/chat-framework/index.js';
import { BedrockExtractor } from '../../apps/api/src/modules/extraction/bedrock-extractor.js';
import type { DocumentStore } from '../../apps/api/src/modules/ingestion-routing/index.js';

/**
 * SoT §16's per-document ceiling, in pence (£0.02).
 *
 * ⚠ IT IS A **BLENDED PIPELINE** CEILING AND THIS SCRIPT MEASURES ONE RUNG.
 * §16 states the intended composition: Textract `AnalyzeExpense` ~0.8p/page ·
 * Nova Lite triage ~0.1–0.2p · a Sonnet coding-suggestion call ~0.6–1.0p ·
 * amortised Opus ~0.2–0.5p. None of those four is built. What runs is the
 * Sonnet vision rung used DIRECTLY — no Textract (D20 is unimplemented), no
 * triage, no escalation ladder, and no coding here at all (the rules engine
 * owns that, deterministically). So today this one number IS the document's
 * whole AI cost, which is what makes the comparison meaningful — and it stops
 * being the whole cost the moment any other rung lands.
 *
 * Do not read a pass here as "D20's pipeline fits the guardrail". It does not
 * say that. Adding Textract in front charges every page and leaves the vision
 * rung firing for whatever fraction falls below threshold: at ~0.8p/page plus a
 * ~1.3p escalation that is ~0.9p if a tenth escalate and ~2.1p — OVER the
 * ceiling — if nearly all do. Measuring that rate is W2's job (D28 keeps the
 * middle rung only if calibration proves it earns its cost).
 */
const GUARDRAIL_PENCE = 2;

const TIER = TASKS.extractionVisionFirst.model;
const REGION = process.env['BEDROCK_REGION'] ?? 'eu-west-2';

/** Bytes from memory instead of S3 — the one stand-in in this measurement. */
function storeOf(bytes: Buffer): DocumentStore {
  return { get: () => Promise.resolve(bytes) } as unknown as DocumentStore;
}

/**
 * A receipt photographed on a phone, at the size one actually arrives at.
 *
 * 1568 px on the long edge is deliberate and it is the whole point of the image
 * half of this measurement: it is what `sharp-image-normaliser.ts` downscales to
 * (A4), and it is the resolution the vision models work at. Image tokens are a
 * function of DIMENSIONS, not of content, so a rendered receipt at the size a
 * real one arrives at bills exactly what a real one bills. Only the output
 * tokens depend on what is written on it, which is why the content below is a
 * realistic UK receipt rather than lorem ipsum: three line items, VAT lines, a
 * VAT number, UK d/m/y dates.
 */
async function receiptJpeg(): Promise<Buffer> {
  const line = (y: number, left: string, right = '', weight = 'normal', size = 26): string =>
    `<text x="60" y="${y}" font-family="monospace" font-size="${size}" font-weight="${weight}" fill="#111">${left}</text>` +
    (right === ''
      ? ''
      : `<text x="1100" y="${y}" font-family="monospace" font-size="${size}" font-weight="${weight}" fill="#111" text-anchor="end">${right}</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1176" height="1568">
    <rect width="100%" height="100%" fill="#f7f5f0"/>
    ${line(90, 'BIDFOOD WHOLESALE LTD', '', 'bold', 34)}
    ${line(130, '18 Priory Road, Manchester M3 4LX')}
    ${line(165, 'VAT No. GB 412 8836 21')}
    ${line(200, 'Tel 0161 496 0110')}
    ${line(255, '--------------------------------------------')}
    ${line(300, 'SALES INVOICE', '', 'bold', 30)}
    ${line(340, 'Invoice No.', 'BF-2026-118374')}
    ${line(375, 'Date', '04/08/2026')}
    ${line(410, 'Due', '03/09/2026')}
    ${line(445, 'Account', 'AMBURG-004')}
    ${line(500, '--------------------------------------------')}
    ${line(545, 'DESCRIPTION', 'AMOUNT', 'bold')}
    ${line(600, '12 x Beef patties 6oz (case)', '84.60')}
    ${line(640, '8 x Brioche buns (pack of 48)', '39.20')}
    ${line(680, '4 x Vegetable oil 20L', '112.00')}
    ${line(735, '--------------------------------------------')}
    ${line(785, 'Subtotal', '235.80')}
    ${line(825, 'VAT @ 20%', '47.16')}
    ${line(880, 'TOTAL DUE', '282.96', 'bold', 32)}
    ${line(940, '--------------------------------------------')}
    ${line(990, 'Payment terms: 30 days net')}
    ${line(1025, 'Bank: 20-45-77  Acct: 60318842')}
    ${line(1090, 'Thank you for your business.')}
  </svg>`;

  // JPEG at quality 82 — what a phone camera or a scanning app produces, and
  // what sanitisation re-encodes to.
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

/**
 * A born-digital supplier invoice as a PDF — the commonest UK business document,
 * and the one A4 taught this extractor to read through the `document` block.
 *
 * Hand-built rather than rendered: a PDF with a real text content stream is a
 * few hundred bytes of well-formed syntax, and adding a PDF library to measure
 * PDF costs would be a dependency decision taken for a script. This is what a
 * born-digital invoice IS — a text layer the model reads directly, not a scan —
 * so the token profile is representative, and it is deliberately under 1 MB
 * because a real one is too.
 */
function invoicePdf(): Buffer {
  const rows: readonly (readonly [string, string])[] = [
    ['Managed IT support - August 2026', '450.00'],
    ['Microsoft 365 Business Premium x 6', '114.00'],
    ['Offsite backup 500GB', '36.00'],
  ];

  const text = [
    'BT 0 0 0 rg /F1 16 Tf 60 780 Td (NORTHGATE TECHNOLOGY SERVICES LTD) Tj ET',
    'BT /F1 10 Tf 60 762 Td (Unit 7 Cathedral Business Park, Leeds LS1 6TG) Tj ET',
    'BT /F1 10 Tf 60 748 Td (VAT Registration No. GB 337 4419 08) Tj ET',
    'BT /F1 13 Tf 60 706 Td (VAT INVOICE) Tj ET',
    'BT /F1 10 Tf 60 686 Td (Invoice number: NTS-4471) Tj ET',
    'BT /F1 10 Tf 60 672 Td (Invoice date: 11/08/2026) Tj ET',
    'BT /F1 10 Tf 60 658 Td (Payment due: 10/09/2026) Tj ET',
    'BT /F1 10 Tf 60 644 Td (Bill to: American Burger Ltd, 44 Deansgate, Manchester M3 2AY) Tj ET',
    'BT /F1 10 Tf 60 604 Td (Description) Tj ET',
    'BT /F1 10 Tf 460 604 Td (Amount GBP) Tj ET',
    ...rows.map(
      ([description, amount], index) =>
        `BT /F1 10 Tf 60 ${584 - index * 16} Td (${description}) Tj ET ` +
        `BT /F1 10 Tf 460 ${584 - index * 16} Td (${amount}) Tj ET`,
    ),
    'BT /F1 10 Tf 60 512 Td (Subtotal) Tj ET BT /F1 10 Tf 460 512 Td (600.00) Tj ET',
    'BT /F1 10 Tf 60 496 Td (VAT at 20%) Tj ET BT /F1 10 Tf 460 496 Td (120.00) Tj ET',
    'BT /F1 12 Tf 60 476 Td (Total payable) Tj ET BT /F1 12 Tf 460 476 Td (720.00) Tj ET',
    'BT /F1 9 Tf 60 436 Td (Terms: 30 days. Late payment interest applies under the Late Payment of) Tj ET',
    'BT /F1 9 Tf 60 424 Td (Commercial Debts (Interest) Act 1998.) Tj ET',
  ].join('\n');

  // Offsets are computed rather than hardcoded: a wrong xref is the difference
  // between a PDF a reader opens and one it rejects, and hardcoding them makes
  // the file unmaintainable the moment the content changes by one character.
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${text.length}>>\nstream\n${text}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

interface Measurement {
  readonly label: string;
  readonly bytes: number;
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly pence: number;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * A real Bedrock client with a tap on it.
 *
 * ⚠ IT FORWARDS THE REQUEST VERBATIM. The extractor still builds the request —
 * the pinned model, the real system prompt, the forced tool call, the untrusted
 * wrapper — and a real `AnthropicBedrock` still makes the call. The wrapper only
 * keeps a reference to the answer, so the token counts reported below are the
 * ones the model actually billed, not a reconstruction. Anything that changed
 * the request here would make the whole measurement meaningless.
 */
function tappedClient(): { client: Pick<AnthropicBedrock, 'messages'>; usage: () => Usage } {
  const real = new AnthropicBedrock({ awsRegion: REGION, maxRetries: 0 });
  let seen: Usage = { input_tokens: 0, output_tokens: 0 };
  const create = async (...args: unknown[]): Promise<unknown> => {
    const response = (await (real.messages.create as (...a: unknown[]) => Promise<unknown>)(...args)) as {
      usage?: Usage;
    };
    seen = { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 };
    return response;
  };
  return {
    client: { messages: { create } } as unknown as Pick<AnthropicBedrock, 'messages'>,
    usage: () => seen,
  };
}

async function measure(label: string, filename: string, mimeType: string, bytes: Buffer): Promise<Measurement> {
  // A ceiling far above one document: this measures cost, it does not test the
  // gate. The gate has its own tests.
  const budget = new InMemoryAiBudget(1_000_000);
  const tap = tappedClient();
  const extractor = new BedrockExtractor({ store: storeOf(bytes), region: REGION, budget, client: tap.client });

  const startedAt = process.hrtime.bigint();
  const outcome = await extractor.extract({
    filename,
    byteHash: 'measurement',
    s3Key: 'measurement',
    mimeType,
    practiceId: 'measure',
  });
  const ms = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  // The pence the METER recorded — read back from the ledger rather than
  // recomputed, so this reports what a practice is actually billed. The tokens
  // come off the tapped response, so the two can be checked against each other.
  const pence = (await budget.check('measure')).spentPence;
  const usage = tap.usage();
  const detail = outcome.ok
    ? [
        `supplier=${outcome.document.supplierName ?? 'null'}`,
        `date=${outcome.document.documentDate ?? 'null'}`,
        `total=${outcome.document.totalPence ?? 'null'}p`,
        `vat=${outcome.document.taxPence ?? 'null'}p`,
        `ref=${outcome.document.reference ?? 'null'}`,
        `vatNo=${outcome.document.vatNumber ?? 'null'}`,
        `lines=${outcome.document.lineItems.length}`,
      ].join(' ')
    : `${outcome.failure.code} ${outcome.failure.message}`;

  return {
    label,
    bytes: bytes.byteLength,
    ms,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    pence,
    ok: outcome.ok,
    detail,
  };
}

async function main(): Promise<void> {
  process.stdout.write(`\nExtraction cost probe — S5 item 4\n`);
  process.stdout.write(`  model    ${MODELS[TIER]}  (TASKS.extractionVisionFirst -> ${TIER})\n`);
  process.stdout.write(`  region   ${REGION}\n`);
  process.stdout.write(`  guardrail ${GUARDRAIL_PENCE}p per document (SoT §16, £0.02 BLENDED)\n`);
  process.stdout.write(`  scope    the Sonnet vision rung ONLY — no Textract, no triage, no ladder\n\n`);

  const documents: readonly [string, string, string, Buffer][] = [
    ['receipt photo (1568px JPEG)', 'bidfood-invoice.jpg', 'image/jpeg', await receiptJpeg()],
    ['supplier invoice (born-digital PDF)', 'northgate-nts-4471.pdf', 'application/pdf', invoicePdf()],
  ];

  const results: Measurement[] = [];
  for (const [label, filename, mimeType, bytes] of documents) {
    process.stdout.write(`reading ${label} (${(bytes.byteLength / 1024).toFixed(0)} KB)...\n`);
    results.push(await measure(label, filename, mimeType, bytes));
    await sleep(500); // be polite to the endpoint between calls
  }

  process.stdout.write('\n');
  for (const result of results) {
    const verdict = result.pence <= GUARDRAIL_PENCE ? 'within' : 'OVER';
    process.stdout.write(`${result.label}\n`);
    process.stdout.write(`  ${(result.bytes / 1024).toFixed(0)} KB · ${(result.ms / 1000).toFixed(1)} s · `);
    process.stdout.write(`${result.inputTokens} in + ${result.outputTokens} out tokens\n`);
    process.stdout.write(`  ${result.pence}p metered · ${verdict} the ${GUARDRAIL_PENCE}p guardrail\n`);
    // ⚠ The meter rounds UP to whole pence per call, and at these token counts
    // the rounding is most of the number — so one document's "1p" says very
    // little about what a thousand cost. Priced per hundred through the SAME
    // `costPence`: writing the rate table out again here to get an unrounded
    // figure would be the exact second-copy problem this stage removed.
    const perHundred = costPence(TIER, result.inputTokens * 100, result.outputTokens * 100);
    process.stdout.write(`  ${perHundred}p per 100 documents = ${(perHundred / 100).toFixed(3)}p each at volume\n`);
    process.stdout.write(`  ${result.ok ? 'read' : 'FAILED'}: ${result.detail}\n\n`);
  }

  const worst = Math.max(...results.map((r) => r.pence));
  process.stdout.write(
    `worst case ${worst}p/document — ${worst <= GUARDRAIL_PENCE ? 'inside' : 'OUTSIDE'} the ${GUARDRAIL_PENCE}p guardrail,\n` +
      `for the ONE rung that exists. Textract (D20) is not in the path; adding it charges every\n` +
      `page on top of whatever fraction still escalates to this read — see GUARDRAIL_PENCE.\n`,
  );
  process.stdout.write(
    `at ${worst}p, one £8.50/month client business covers ${Math.floor(850 / Math.max(worst, 1))} documents a month in reading cost alone.\n\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
