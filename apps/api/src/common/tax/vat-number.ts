import { z } from 'zod';

/**
 * UK VAT registration numbers — format and HMRC modulus check, pure.
 *
 * Lives in `common/` because two modules need the same answer: the extraction
 * pipeline (a supplier's number off an invoice) and tax-compliance (the
 * client's own number at intake). Two copies of a checksum is how one side
 * accepts a number the other refuses.
 *
 * Shapes accepted, after stripping spaces/dots/hyphens and an optional `GB`:
 * - 9 digits — the standard VRN;
 * - 12 digits — a VRN plus a 3-digit branch trader suffix (checked on the 9);
 * - `GD` + 3 digits (000–499) — government departments;
 * - `HA` + 3 digits (500–999) — health authorities.
 *
 * The checksum: weights 8..2 over the first seven digits, plus the last two
 * digits as a number. The total is a multiple of 97 (the original series) or
 * becomes one after adding 55 (the "9755" series, issued from 2010).
 */

export type VrnShape = 'STANDARD' | 'GOVERNMENT' | 'HEALTH';

export type VrnValidation =
  | { readonly valid: true; readonly normalised: string; readonly digits: string; readonly shape: VrnShape }
  | { readonly valid: false; readonly normalised: string; readonly reason: 'INVALID_FORMAT' | 'INVALID_CHECKSUM' };

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2] as const;

export function validateVrn(raw: string): VrnValidation {
  const cleaned = raw.toUpperCase().replace(/[\s.\-]/g, '');
  const body = cleaned.startsWith('GB') ? cleaned.slice(2) : cleaned;

  const special = /^(GD|HA)(\d{3})$/.exec(body);
  if (special !== null) {
    const kind = special[1] as 'GD' | 'HA';
    const n = Number(special[2]);
    const inRange = kind === 'GD' ? n <= 499 : n >= 500;
    return inRange
      ? { valid: true, normalised: `GB${body}`, digits: body, shape: kind === 'GD' ? 'GOVERNMENT' : 'HEALTH' }
      : { valid: false, normalised: `GB${body}`, reason: 'INVALID_FORMAT' };
  }

  if (!/^\d{9}(\d{3})?$/.test(body)) return { valid: false, normalised: cleaned, reason: 'INVALID_FORMAT' };
  const nine = body.slice(0, 9);
  const normalised = `GB${nine}`;
  if (/^0+$/.test(nine)) return { valid: false, normalised, reason: 'INVALID_CHECKSUM' };

  const total = WEIGHTS.reduce((sum, weight, i) => sum + weight * Number(nine[i]), 0) + Number(nine.slice(7));
  const ok = total % 97 === 0 || (total + 55) % 97 === 0;
  return ok ? { valid: true, normalised, digits: nine, shape: 'STANDARD' } : { valid: false, normalised, reason: 'INVALID_CHECKSUM' };
}

/**
 * The stored/served verdict — the contract's `VatNumberCheck`. Written to
 * `documents.supplier_vat_check` and `tax_profiles.vat_number_check` (Json),
 * so it is PARSED on the way out, never cast.
 */
export const VatNumberCheckSchema = z.object({
  vatNumber: z.string(),
  status: z.enum(['VALID', 'NOT_REGISTERED', 'CHECKSUM_ONLY', 'INVALID_FORMAT', 'INVALID_CHECKSUM']),
  source: z.enum(['HMRC', 'CHECKSUM']),
  registeredName: z.string().nullable(),
  registeredAddress: z.string().nullable(),
  note: z.string().nullable(),
  checkedAt: z.string(),
});
export type VatNumberCheck = z.infer<typeof VatNumberCheckSchema>;

/** A stored Json value → a verdict, or null for anything that is not one. */
export function readVatNumberCheck(value: unknown): VatNumberCheck | null {
  const parsed = VatNumberCheckSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
