import type { ProposalKind } from '@neoting/contracts/model';

/**
 * The review renderer — what `[Read review]` shows and what
 * `rendered_summary_hash` is computed over.
 *
 * The contract owns the transport and the hash; the shape belongs to the
 * Review → Approve primitive in `packages/component-grammar` (the
 * `ProposalReview` schema says so in as many words), so this stays a simple
 * `{title, sections, warnings}` that the grammar can formalise later without
 * a second source of truth appearing here.
 *
 * Two properties are load-bearing:
 *
 * - **Deterministic.** Same payload → same summary → same hash. The render is
 *   a pure function of the payload; nothing here reads a clock or the
 *   database. When a kind's review needs live facts (publish previews compute
 *   them INTO the payload at proposal time — METH S10 — precisely so the
 *   reviewed thing is the stored thing), they arrive in the payload.
 * - **Nothing summarised away.** For `chase.send` that means every SMS
 *   byte-for-byte and its recipient — the contract's own words. A summary
 *   that paraphrased the SMS would break the "what was approved is what was
 *   shown" guarantee at the rendering step, where no hash could catch it.
 */
export interface RenderedSummary {
  readonly title: string;
  readonly sections: readonly RenderedSection[];
  readonly warnings: readonly { code: string; message: string; requiresAcknowledgement: boolean }[];
}

export interface RenderedSection {
  readonly heading: string;
  readonly entries: readonly { label: string; value: string }[];
}

export function renderSummary(kind: ProposalKind, payload: Record<string, unknown>): RenderedSummary {
  switch (kind) {
    case 'document.archive': {
      const ids = stringArray(payload['documentIds']);
      const archived = payload['archived'] === true;
      return summary(
        archived ? `Archive ${count(ids.length, 'document')}` : `Restore ${count(ids.length, 'document')} from the archive`,
        [{ heading: 'Documents', entries: ids.map((id, i) => ({ label: `Document ${i + 1}`, value: id })) }],
      );
    }
    case 'document.route':
      return summary(`Route document to ${text(payload['inbox'])}`, [
        {
          heading: 'Routing',
          entries: [
            { label: 'Document', value: text(payload['documentId']) },
            { label: 'Inbox', value: text(payload['inbox']) },
            ...(payload['toBusinessId'] == null ? [] : [{ label: 'Assign to business', value: text(payload['toBusinessId']) }]),
            ...(payload['teachRouterForSender'] === true
              ? [{ label: 'Teach router', value: 'Always route this sender here' }]
              : []),
          ],
        },
      ]);
    case 'document.update-coding': {
      const fields = isObject(payload['fields']) ? payload['fields'] : {};
      const entries = Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([label, value]) => ({ label, value: text(value) }));
      return summary(`Update coding — ${entries.map((e) => e.label).join(', ')}`, [
        {
          heading: 'Field changes',
          entries: [{ label: 'Document', value: text(payload['documentId']) }, ...entries],
        },
      ]);
    }
    case 'chase.send': {
      // Every message verbatim, every recipient — the whole point of the review.
      const messages = Array.isArray(payload['messages']) ? payload['messages'] : [];
      return summary(
        `Send ${count(messages.length, 'chase message')}`,
        messages.map((m, i) => {
          const msg = isObject(m) ? m : {};
          // Under the email transport (SMS_SENDER=email) the message goes to
          // the named contact's ADDRESS, resolved into the payload at creation
          // (compose-chase-send.ts) precisely so the reviewer sees it — the
          // A13 leftover this closes. Older payloads carry only the number.
          const email = typeof msg['recipientEmail'] === 'string' && msg['recipientEmail'] !== '' ? msg['recipientEmail'] : null;
          const period = typeof msg['statementPeriod'] === 'string' && msg['statementPeriod'] !== '' ? msg['statementPeriod'] : null;
          return {
            heading: `Message ${i + 1} — to ${email ?? text(msg['recipientE164'])}`,
            entries: [
              { label: 'Message, exactly as it will send', value: text(msg['body']) },
              ...(email !== null ? [{ label: 'Registered mobile on file', value: text(msg['recipientE164']) }] : []),
              // A statement request (engine (c)) asks for a month, not lines.
              period !== null
                ? { label: 'Requesting bank statement for', value: period }
                : { label: 'Chasing transactions', value: stringArray(msg['transactionIds']).join(', ') },
            ],
          };
        }),
      );
    }
    case 'publish.batch': {
      const ids = stringArray(payload['documentIds']);
      const preview = isObject(payload['preview']) ? payload['preview'] : {};
      // Null when the batch mixes currencies — the totals are then rendered
      // without a symbol and the card says why, rather than picking one.
      const code = typeof preview['currency'] === 'string' ? (preview['currency'] as string) : null;
      const gross = penceToMoney(preview['grossPence'], code);
      const vat = penceToMoney(preview['vatPence'], code);
      const mixed = code === null;
      const entries = entryPreviewSections(payload['entryPreview']);
      return summary(
        mixed
          ? `Release ${count(ids.length, 'document')} for export — gross ${gross}, VAT ${vat} (mixed currencies)`
          : `Release ${count(ids.length, 'document')} for export — gross ${gross}, VAT ${vat}`,
        [
        {
          heading: 'Server-computed preview',
          entries: [
            { label: 'Items', value: String(ids.length) },
            { label: 'Gross', value: gross },
            { label: 'VAT', value: vat },
            ...(mixed
              ? [{
                  label: 'Currency',
                  value: 'These documents are not all in one currency, so the totals above carry no symbol.',
                }]
              : [{ label: 'Currency', value: code }]),
          ],
        },
        ...entries,
        // Still listed, and still last. The entry sections above name each
        // document too, but an id that produced NO rows — refused, or a payload
        // written before the entry preview existed — would otherwise vanish
        // from the card entirely.
        { heading: 'Documents', entries: ids.map((id, i) => ({ label: `Document ${i + 1}`, value: id })) },
      ],
      );
    }
    case 'document.reject': {
      // The reason VERBATIM, as its own entry — the contract calls it
      // "surfaced verbatim in the Rejected view", and the review is where a
      // human agrees to the words that will sit on someone's document.
      const ids = stringArray(payload['documentIds']);
      return summary(`Reject ${count(ids.length, 'document')}`, [
        {
          heading: 'Reason, exactly as it will be recorded',
          entries: [{ label: 'Reason', value: text(payload['reason']) }],
        },
        { heading: 'Documents', entries: ids.map((id, i) => ({ label: `Document ${i + 1}`, value: id })) },
      ]);
    }
    case 'document.purge': {
      // ⚠ The one card on this surface where "what will happen" is not
      // recoverable afterwards, so it says everything: what is destroyed, what
      // survives, and — the `document.reprocess` precedent — what it does NOT
      // do despite what a reader would reasonably assume.
      //
      // The refusal is on the card too, and deliberately as a promise rather
      // than a result: `render-summary.ts` is payload-pure and may not read a
      // database, so it CANNOT tell this reviewer whether these particular
      // documents are exported. What it can honestly say is that the executor
      // will check and will refuse, which is the fact the reviewer needs in
      // order to know an approval here is safe to give.
      const ids = stringArray(payload['documentIds']);
      const reason = payload['reason'];
      return summary(`Permanently delete ${count(ids.length, 'document')}`, [
        {
          heading: 'This cannot be undone',
          entries: [
            { label: 'Document records', value: 'Destroyed' },
            { label: 'Extractions, processing log, duplicate pairs', value: 'Destroyed with them' },
            { label: 'Audit trail', value: 'Kept — the record of this deletion outlives the documents' },
            { label: 'Stored files', value: 'NOT deleted — the bytes stay in storage; no sweep exists yet' },
          ],
        },
        {
          heading: 'What will be refused',
          entries: [
            {
              label: 'Released for export, or carrying an export link',
              value: 'Refused — the whole batch, checked against the export and link records at the moment you approve',
            },
            { label: 'Not already in Trash', value: 'Refused — delete it first, which is reversible' },
          ],
        },
        ...(typeof reason === 'string' && reason.length > 0
          ? [{ heading: 'Reason, exactly as it will be recorded', entries: [{ label: 'Reason', value: text(reason) }] }]
          : []),
        { heading: 'Documents', entries: ids.map((id, i) => ({ label: `Document ${i + 1}`, value: id })) },
      ]);
    }
    case 'bank.remove-statement': {
      // The blast radius, per statement, in the server's own numbers — the
      // payload's preview was computed at creation over the provenance-stamped
      // rows and the caller's figures were discarded (the publish.batch
      // pattern). The reviewer recognises a statement by its FILE NAME, so it
      // leads each entry; the executor recomputes at approve and refuses on
      // drift, which the card states as a promise (the document.purge
      // precedent — this render is payload-pure and cannot check live facts).
      const preview = payload['preview'] as
        | {
            statements?: readonly {
              statementId?: string;
              fileName?: string | null;
              periodStart?: string | null;
              periodEnd?: string | null;
              transactionCount?: number;
            }[];
            totalTransactions?: number;
          }
        | undefined;
      const statements = Array.isArray(preview?.statements) ? preview.statements : [];
      return summary(`Remove ${count(statements.length, 'statement')} and ${count(preview?.totalTransactions ?? 0, 'imported transaction')}`, [
        {
          heading: 'What this removes, and what it keeps',
          entries: [
            { label: 'The statement and its imported bank lines', value: 'Removed — hard delete of the derived rows' },
            { label: 'The uploaded file', value: 'Kept in the vault — re-uploading re-imports and re-proves completeness (D41)' },
            { label: 'Closed chases', value: 'Kept — the record of what was asked survives' },
          ],
        },
        {
          heading: 'What will be refused at the moment you approve',
          entries: [
            { label: 'A line matched to a document', value: 'Refused — a confirmed match is an accountant’s assertion' },
            { label: 'A line a client is being chased about', value: 'Refused — close the chase first' },
            { label: 'Counts that changed since this review', value: 'Refused — propose it again over the current facts' },
          ],
        },
        {
          heading: 'Statements',
          entries: statements.map((entry, i) => ({
            label: entry.fileName ?? entry.statementId ?? `Statement ${i + 1}`,
            value: `${count(entry.transactionCount ?? 0, 'transaction')}${entry.periodStart != null && entry.periodEnd != null ? ` · ${entry.periodStart} → ${entry.periodEnd}` : ''}`,
          })),
        },
      ]);
    }
    case 'document.reprocess': {
      // ⚠ The card states the LIMIT, not just the intent. `reprocess-document.ts`
      // clears the failure and re-decides readiness; it does not read the bytes
      // again, because nothing here can enqueue a pipeline job yet. Review →
      // Approve promises that what was shown is what happens, so the shortfall
      // belongs on the card a human approves rather than in a file they will
      // never open.
      const ids = stringArray(payload['documentIds']);
      const fromStage = payload['fromStage'];
      return summary(`Retry ${count(ids.length, 'document')}`, [
        {
          heading: 'What this does',
          entries: [
            { label: 'Clears the failure reason', value: 'Yes' },
            { label: 'Re-checks Total, Supplier and Category', value: 'Yes — the document returns to Ready or To Review' },
            { label: 'Reads the document again', value: 'No — extraction is not re-run' },
            ...(fromStage == null ? [] : [{ label: 'Requested from stage', value: text(fromStage) }]),
          ],
        },
        { heading: 'Documents', entries: ids.map((id, i) => ({ label: `Document ${i + 1}`, value: id })) },
      ]);
    }
    case 'rule.create': {
      // The rule the approval activates — fields, tier and scope spelled out
      // (METH S13): a reviewer must see exactly what will start coding their
      // client's documents, not a JSON blob of it.
      const scopeKey = typeof payload['scopeKey'] === 'string' ? payload['scopeKey'] : null;
      const sets = isObject(payload['sets']) ? payload['sets'] : {};
      const conditions = isObject(payload['conditions']) ? payload['conditions'] : null;
      const setEntries = Object.entries(sets)
        .filter(([, v]) => v !== undefined)
        .map(([label, value]) => ({ label, value: text(value) }));
      return summary(`Create rule: ${scopeKey ?? text(payload['tier'])} → ${setEntries.map((e) => `${e.label} ${e.value}`).join(', ')}`, [
        {
          heading: 'Rule that will be created',
          entries: [
            { label: 'Tier', value: text(payload['tier']) },
            { label: 'Matches', value: scopeKey ?? 'Every document in scope' },
            {
              label: 'Conditions',
              value:
                conditions === null
                  ? 'Always'
                  : Object.entries(conditions)
                      .map(([k, v]) => `${k}: ${text(v)}`)
                      .join(' · '),
            },
          ],
        },
        { heading: 'Fields this rule sets', entries: setEntries },
      ]);
    }
    case 'business.offboard': {
      // The render is payload-pure (the property this file's header pins), and
      // `BusinessOffboardPayload` carries the id, not the name — the generated
      // member schema is `.strict()`, so the name cannot be computed into the
      // stored payload the way publish previews are. The title is therefore
      // honest about the act and the id; the surface that knows the name may
      // render it beside this. What the card must not leave unsaid is the D12
      // half: nothing is deleted.
      const reason = typeof payload['reason'] === 'string' ? payload['reason'] : null;
      return summary(`Offboard client workspace ${text(payload['businessId'])} — books retained`, [
        {
          heading: 'What this does',
          entries: [
            { label: 'Business', value: text(payload['businessId']) },
            { label: 'Deactivates the workspace', value: 'Yes — it leaves the client list and every working surface' },
            { label: 'Deletes books, documents or the audit trail', value: 'No — retained for the six-year requirement' },
            ...(reason === null ? [] : [{ label: 'Reason, exactly as it will be recorded', value: reason }]),
          ],
        },
      ]);
    }
    default:
      // Honest generic rendering for the kinds whose stages have not shaped a
      // richer card yet (move-business, split, revoke-link, bank.confirm-match):
      // every payload member, named. `reprocess` and `reject` left this list in
      // stage A12.
      return summary(`${kind}`, [
        {
          heading: 'Proposed action',
          entries: Object.entries(payload)
            .filter(([, v]) => v !== undefined)
            .map(([label, value]) => ({ label, value: text(value) })),
        },
      ]);
  }
}

function summary(title: string, sections: readonly RenderedSection[]): RenderedSummary {
  return { title, sections, warnings: [] };
}

/**
 * **The bookkeeping entry, on the card.**
 *
 * The owner's ask, in his words: *"before publishing show the accountant the
 * actual accounting entry that will be put into the VT software."* Until this,
 * `publish.batch`'s review showed a count and two totals — a person pressing
 * Approve was authorising rows they had never seen, which is the failure the
 * whole Review → Approve pattern exists to prevent.
 *
 * ⚠ **Nothing here formats a cell.** Every string below comes out of
 * `payload.entryPreview`, which the engine computed at proposal time by calling
 * the EXPORT'S OWN EMITTER (`exports-public-api`'s `previewExportEntries` →
 * `emitter.previewEntries`, built by the same function as `emitter.emit`). This
 * function chooses headings and labels; it does not decide what goes in a
 * column, how money is rendered, which file a document lands in, or what
 * warnings apply. A render that re-derived any of those would be a second
 * opinion about the file, and a confident second opinion on a review card is
 * worse than no card at all.
 *
 * ⚠ **D42 vocabulary is load-bearing here, not stylistic.** This release has no
 * ledger connection: the file is downloaded and the accountant imports it
 * themselves. Nothing in these strings may say or imply posted, synced, sent, or
 * that anything reaches accounting software on its own. `render-summary.test.ts`
 * reads the rendered strings and fails on the vocabulary, mirroring
 * `apps/web/src/views/ExportView.test.tsx`.
 *
 * Absent `entryPreview` renders nothing rather than an apology — a payload
 * written before the field existed still reviews, with the card it always had.
 */
function entryPreviewSections(value: unknown): RenderedSection[] {
  if (!isObject(value)) return [];
  const columns = stringArray(value['columns']);
  const documents = Array.isArray(value['documents']) ? value['documents'] : [];
  const refusals = Array.isArray(value['refusals']) ? value['refusals'] : [];
  if (columns.length === 0 && documents.length === 0 && refusals.length === 0) return [];

  const sections: RenderedSection[] = [];
  const totalRows = documents.reduce(
    (total, document) => total + (isObject(document) && Array.isArray(document['rows']) ? document['rows'].length : 0),
    0,
  );

  sections.push({
    heading: 'The accounting entry this release will put in the import file',
    entries: [
      { label: 'Import file', value: targetName(value['target']) },
      { label: 'Columns, in the order the file writes them', value: columns.join(' · ') },
      // Rows, not documents: a document coded across two nominals is two lines,
      // and the number an accountant reconciles against their own software's
      // preview is the line count.
      { label: 'Lines the file will carry', value: String(totalRows) },
      {
        label: 'What approving does',
        value:
          'Releases these documents for export. The file is produced when you download it on the Export screen, and you import it yourself — nothing here reaches accounting software.',
      },
    ],
  });

  documents.forEach((document, index) => {
    if (!isObject(document)) return;
    const rows = Array.isArray(document['rows']) ? document['rows'] : [];
    const entries: { label: string; value: string }[] = [
      { label: 'Document', value: text(document['documentId']) },
    ];

    const fileName = typeof document['fileName'] === 'string' ? document['fileName'] : '';
    if (fileName !== '') {
      const dataFormat = typeof document['dataFormat'] === 'string' ? document['dataFormat'] : '';
      entries.push({
        label: 'Lands in',
        value: dataFormat === '' ? fileName : `${fileName} — data format "${dataFormat}"`,
      });
    }

    rows.forEach((row, line) => {
      const cells = stringArray(row);
      cells.forEach((cell, column) => {
        entries.push({
          // The column's own name, so the reviewer reads the file's vocabulary
          // and not ours. Prefixed with the line only when there is more than
          // one, because a split analysis is the case where "which line?" is a
          // real question and a single-line entry is the case where it is noise.
          label: rows.length > 1 ? `Line ${line + 1} · ${columns[column] ?? `Column ${column + 1}`}` : (columns[column] ?? `Column ${column + 1}`),
          // ⚠ VERBATIM. This is the exact string the file will contain,
          // including the emitter's own money rendering — an empty continuation
          // cell shows as empty, because that is what the file carries.
          value: cell,
        });
      });
    });

    const warnings = Array.isArray(document['warnings']) ? document['warnings'] : [];
    for (const warning of warnings) {
      if (!isObject(warning)) continue;
      entries.push({ label: `Check before you import — ${text(warning['code'])}`, value: text(warning['message']) });
    }

    sections.push({
      // The counterparty is the first cell in every target this release has, and
      // it is what an accountant recognises. Falling back to the index rather
      // than to the opaque id, which is already the first entry.
      heading: `Entry ${index + 1}${firstCell(rows) === '' ? '' : ` — ${firstCell(rows)}`}`,
      entries,
    });
  });

  if (refusals.length > 0) {
    sections.push({
      heading: 'Documents that would produce no line in the file',
      entries: refusals.filter(isObject).map((refusal) => ({
        label: text(refusal['documentId']),
        value: text(refusal['message']),
      })),
    });
  }

  return sections;
}

/** The target, in the words the accountant's own software uses. Never a claim about a connection. */
function targetName(target: unknown): string {
  if (target === 'VT_TRANSACTION_PLUS') return 'VT Transaction+ — Transaction ▸ Journal ▸ Import…';
  if (target === 'GENERIC_CSV') return 'Generic CSV';
  return text(target);
}

function firstCell(rows: readonly unknown[]): string {
  return stringArray(rows[0])[0] ?? '';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '—';
  return JSON.stringify(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Integer pence → "£12.34" with STRING arithmetic — no division, so no float
 * ever touches a monetary value, even transiently in a formatter (the repo's
 * most-guarded invariant, applied to rendering too).
 */
/** Symbols we will print. Anything else is stated by its ISO code. */
const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

/**
 * Integer pence → the figure a human approves.
 *
 * ⚠ **`code` is not optional in spirit.** This printed `£` unconditionally, so
 * a USD invoice rendered on the approval card as `gross £54352.51` — a wrong
 * currency on the Review → Approve path, which is the one place the product
 * guarantees that what was shown is what was approved. `null` means the batch
 * mixes currencies, and then no symbol is honest: the amount is rendered bare
 * with the reason said in words beside it (see the `publish.batch` case).
 */
function penceToMoney(value: unknown, code: string | null): string {
  if (typeof value !== 'number' || !Number.isInteger(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value)).padStart(3, '0');
  const amount = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  if (code === null) return `${sign}${amount}`;
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
  return `${sign}${symbol}${amount}`;
}
