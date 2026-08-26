import { HttpStatus } from '@nestjs/common';

import { ProposalKind } from '@neoting/contracts/model';
import { createActionProposalBody } from '@neoting/contracts/zod';
import type { z } from 'zod';

import { AppException } from '../../common/problem/problem.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';

/**
 * Parsing `CreateActionProposalRequest` — and why the generated union cannot
 * be used whole. Two orval gaps meet on this one schema (both measured on
 * v7.21, in the pinning tests below — the `enforce-money-int` habit of
 * recording what bit):
 *
 * 1. **The discriminator is `zod.unknown()`.** The OpenAPI `const` keyword is
 *    not mapped to `zod.literal`, so the union cannot tell an archive from a
 *    reprocess — a body claiming one kind with another kind's payload would
 *    parse as *something*. Member selection therefore happens here, keyed by
 *    the spec's own `oneOf` order (`KIND_ORDER` mirrors it; the test pins it).
 *
 * 2. **`allOf` becomes an intersection of two `.strict()` objects** —
 *    `{businessId}.strict() ∧ {kind, payload}.strict()` — and a strict
 *    intersection rejects EVERY input: each half reports the other half's
 *    keys as unrecognized. The generated union whole-schema has never
 *    accepted a single valid request. So the two generated halves are parsed
 *    separately over a split of the input, and the top-level key set is
 *    checked here so `.strict()`'s misspelled-field behaviour survives.
 *
 * Nothing here describes a payload shape by hand — both halves are the
 * generated schemas, verbatim. If orval ever fixes either gap, the union
 * becomes usable whole, this file reduces to one `parseBoundary`, and the
 * pinning tests are what make that safe to notice.
 */
const KIND_ORDER: readonly ProposalKind[] = [
  'document.route',
  'document.update-coding',
  'document.move-business',
  'document.reprocess',
  'document.reject',
  'document.split',
  'document.archive',
  'chase.send',
  'publish.batch',
  'bank.confirm-match',
  'rule.create',
  'document.revoke-link',
];

const KNOWN_KINDS = new Set<string>(Object.values(ProposalKind));
const TOP_LEVEL_KEYS = new Set(['kind', 'payload', 'businessId']);

/** The boundary-parsed create request, ready for the service. Throws 400 `NT-VAL-001` problem+json. */
export function parseCreateProposalBody(
  kind: ProposalKind,
  body: Record<string, unknown>,
): { businessId: string | null; payload: Record<string, unknown> } {
  // .strict()'s behaviour, kept: a misspelled top-level field is a named 400,
  // not a silent drop (the halves cannot see each other's keys, so the check
  // has to live at the split).
  const unrecognized = Object.keys(body).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unrecognized.length > 0) {
    throw new AppException(
      'NT-VAL-001',
      HttpStatus.BAD_REQUEST,
      'Validation failed',
      'The request body did not match the API contract.',
      unrecognized.map((field) => ({ field, message: 'Unrecognized field. It is not part of the API contract for this request.' })),
    );
  }
  const halves = memberHalves(kind);
  const base = parseBoundary(halves.base, 'businessId' in body ? { businessId: body['businessId'] } : {}, 'request body') as {
    businessId?: string | null;
  };
  const action = parseBoundary(halves.action, { kind: body['kind'], payload: body['payload'] }, 'request body') as {
    payload: Record<string, unknown>;
  };
  return { businessId: base.businessId ?? null, payload: action.payload };
}

/**
 * The stored payload re-parsed against its kind's generated schema at
 * review/execution time — the row sat in a table in between, and executors do
 * not re-validate (#81). Null when it no longer parses; the engine maps that
 * to `NT-PRP-006` rather than letting an executor see unvalidated bytes.
 */
export function parseStoredProposalPayload(kind: ProposalKind, payload: unknown): Record<string, unknown> | null {
  const parsed = memberHalves(kind).action.safeParse({ kind, payload });
  return parsed.success ? (parsed.data as { payload: Record<string, unknown> }).payload : null;
}

/** The registry allow-list check (`NT-PRP-001` at the boundary). Null for anything off the enum. */
export function knownProposalKind(value: unknown): ProposalKind | null {
  return typeof value === 'string' && KNOWN_KINDS.has(value) ? (value as ProposalKind) : null;
}

/** The two generated halves of one union member: `{businessId}` and `{kind, payload}`. */
function memberHalves(kind: ProposalKind): { base: z.ZodTypeAny; action: z.ZodTypeAny } {
  const options = (createActionProposalBody as unknown as { options?: unknown[] }).options;
  const member = options?.[KIND_ORDER.indexOf(kind)] as { _def?: { left?: z.ZodTypeAny; right?: z.ZodTypeAny } } | undefined;
  const base = member?._def?.left;
  const action = member?._def?.right;
  if (base === undefined || action === undefined) {
    // Regeneration changed the union's shape under us; refuse loudly rather
    // than validate against the wrong member. The pinning test fails first.
    throw new Error(`no generated request schema for kind ${kind} — proposal-body.ts is out of step with the contract`);
  }
  return { base, action };
}
