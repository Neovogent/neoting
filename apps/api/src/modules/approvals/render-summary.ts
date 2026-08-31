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
      // Every SMS verbatim, every recipient — the whole point of the review.
      const messages = Array.isArray(payload['messages']) ? payload['messages'] : [];
      return summary(
        `Send ${count(messages.length, 'chase SMS message')}`,
        messages.map((m, i) => {
          const msg = isObject(m) ? m : {};
          return {
            heading: `Message ${i + 1} — to ${text(msg['recipientE164'])}`,
            entries: [
              { label: 'SMS, exactly as it will send', value: text(msg['body']) },
              { label: 'Chasing transactions', value: stringArray(msg['transactionIds']).join(', ') },
            ],
          };
        }),
      );
    }
    case 'publish.batch': {
      const ids = stringArray(payload['documentIds']);
      const preview = isObject(payload['preview']) ? payload['preview'] : {};
      const gross = penceToGbp(preview['grossPence']);
      const vat = penceToGbp(preview['vatPence']);
      return summary(`Publish ${count(ids.length, 'document')} — gross ${gross}, VAT ${vat}`, [
        {
          heading: 'Server-computed preview',
          entries: [
            { label: 'Items', value: String(ids.length) },
            { label: 'Gross', value: gross },
            { label: 'VAT', value: vat },
          ],
        },
        { heading: 'Documents', entries: ids.map((id, i) => ({ label: `Document ${i + 1}`, value: id })) },
      ]);
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
function penceToGbp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value)).padStart(3, '0');
  return `${sign}£${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
