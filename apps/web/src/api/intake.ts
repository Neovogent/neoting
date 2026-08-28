import { z } from 'zod';
import { createBusiness } from '@neoting/contracts/client';
import {
  createBusinessBody,
  createBusinessBodyPrimaryContactMobileE164RegExp,
} from '@neoting/contracts/zod';
import type { BusinessCreateRequest } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * Client intake against `POST /v1/businesses` (launch M7, over Abdullah's A11).
 *
 * One call does the whole job: the server creates the workspace, its primary
 * contact, its VT integration and the setup invite in one transaction, and the
 * registration email carries the link — there is no second "send the invite"
 * call for a screen to forget. D47 is structural here: the contract's body
 * schema is strict, so a bank-connection or ledger-connection field could not
 * reach the endpoint even if a form grew one.
 *
 * This module must stay OFF the bundle floor: it is imported only by the lazy
 * `ClientIntakeForm` chunk, and it deliberately imports the plain generated
 * `createBusiness` function rather than the hook/queryKey machinery — the
 * businesses client module is already floor-resident via `api/businesses.ts`,
 * and the marginal cost is per-export (apps/web/CLAUDE.md, Bundle).
 */

/** How a toggle the accountant never touched stays an honest non-answer. */
export type TriState = 'unknown' | 'yes' | 'no';

/**
 * The form's own state — strings as typed, before any trimming or shaping.
 * `buildIntakeRequest` is the one place this becomes the contract's shape.
 */
export interface IntakeDraft {
  name: string;
  tradingName: string;
  companyNumber: string;
  industry: string;
  vatRegistered: boolean;
  vatNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  mobile: string;
  businessActivity: string;
  typicalSuppliers: string;
  typicalCosts: string;
  hasEmployees: TriState;
  usesSubcontractors: TriState;
  notes: string;
}

/**
 * What the contract requires and the form must therefore collect, named so the
 * live form can gate each STEP on its own fields rather than surprising the
 * accountant at the review. `emailShape` is a light pre-check only — the
 * contract's own schema at `buildIntakeRequest` is the real gate; this exists
 * so an obviously malformed address is refused on the contact step, not three
 * steps later (the LoginView stance: refused before the network).
 */
/**
 * Which of the two intake paths is being walked (D47, prototype instruction #6).
 *
 * `practice` — the accountant keys the whole record in, business-type profile
 * included, and the client is created ready to code documents.
 *
 * `invite` — the accountant supplies only the company name, the responsible
 * person and their contact; the client registers the rest from the setup link.
 * The profile is therefore ABSENT rather than empty, and the request omits the
 * key entirely.
 *
 * Declared here rather than in the form because it changes what is SENT, not
 * merely what is shown: both the required-field set and the assembled body
 * depend on it.
 */
export type IntakeMode = 'invite' | 'practice';

export type IntakeMissingField =
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'emailShape'
  | 'businessActivity';

const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;

export function missingIntakeFields(draft: IntakeDraft, mode: IntakeMode = 'practice'): IntakeMissingField[] {
  const email = draft.email.trim();
  return [
    ...(draft.name.trim() ? [] : ['name' as const]),
    ...(draft.firstName.trim() ? [] : ['firstName' as const]),
    ...(draft.lastName.trim() ? [] : ['lastName' as const]),
    ...(email ? [] : ['email' as const]),
    ...(email && !EMAIL_SHAPE.test(email) ? ['emailShape' as const] : []),
    // The invite path does not ask for the business-type profile at all, so it
    // cannot be owed one. D47 and the prototype's #6 say intake asks the
    // practice for a company name, a responsible person and a contact — the
    // client answers the rest from their setup link, and demanding it here
    // would mean an accountant guessing at a business they have not spoken to.
    ...(mode === 'invite' || draft.businessActivity.trim().length >= 3
      ? []
      : ['businessActivity' as const]),
  ];
}

export type IntakeRefusal =
  /** The mobile is present and cannot be an E.164 number — refused, not guessed. */
  | { reason: 'mobileNotE164' }
  /** The assembled request fails the contract's own schema, with the field named. */
  | { reason: 'contract'; detail: string };

export type IntakeBuild =
  | { ok: true; request: BusinessCreateRequest }
  | { ok: false; refusal: IntakeRefusal };

/** "Nisbets, Costco" → ['Nisbets', 'Costco'] — trimmed, empties dropped. */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Draft → contract request, refused before the network when it cannot parse.
 *
 * Two shaping rules that are decisions, not conveniences:
 *
 * - **An absent optional answer is an omitted key, never null and never an
 *   empty string.** The questionnaire is the only coding context the AI gets
 *   (§24.4), and a stored `""` or a defaulted `false` would read as an answer
 *   an accountant never gave. The tri-state toggles exist for the same
 *   reason: 'unknown' omits the key.
 * - **A mobile without its country code is refused, not guessed** — the same
 *   stance `toE164` takes in `lib/demoIntents.ts`. Prefixing +44 would file a
 *   non-UK client's number as a UK one, silently.
 */
export function buildIntakeRequest(draft: IntakeDraft, mode: IntakeMode = 'practice'): IntakeBuild {
  const mobile = draft.mobile.replace(/[\s()-]/g, '');
  if (mobile && !createBusinessBodyPrimaryContactMobileE164RegExp.test(mobile)) {
    return { ok: false, refusal: { reason: 'mobileNotE164' } };
  }

  const tradingName = draft.tradingName.trim();
  const companyNumber = draft.companyNumber.trim();
  const industry = draft.industry.trim();
  const vatNumber = draft.vatNumber.trim();
  const notes = draft.notes.trim();
  const typicalSuppliers = splitList(draft.typicalSuppliers);
  const typicalCosts = splitList(draft.typicalCosts);

  const request: BusinessCreateRequest = {
    name: draft.name.trim(),
    ...(tradingName ? { tradingName } : {}),
    ...(companyNumber ? { companyNumber } : {}),
    ...(industry ? { industry } : {}),
    vatRegistered: draft.vatRegistered,
    ...(draft.vatRegistered && vatNumber ? { vatNumber } : {}),
    primaryContact: {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      email: draft.email.trim(),
      ...(mobile ? { mobileE164: mobile } : {}),
    },
    // ⚠ OMITTED on the invite path, never sent empty or defaulted.
    //
    // The questionnaire is the only coding context this release has (§24.4),
    // and an invented `businessActivity` reads exactly like one an accountant
    // wrote while silently miscoding every document that follows. An absent key
    // is the honest statement that nobody has answered yet; the client answers
    // it during their own onboarding, and until they do the server reports the
    // business as having no profile rather than a wrong one.
    ...(mode === 'invite'
      ? {}
      : {
          contextQuestionnaire: {
            businessActivity: draft.businessActivity.trim(),
            ...(typicalSuppliers.length ? { typicalSuppliers } : {}),
            ...(typicalCosts.length ? { typicalCosts } : {}),
            ...(draft.hasEmployees !== 'unknown' ? { hasEmployees: draft.hasEmployees === 'yes' } : {}),
            ...(draft.usesSubcontractors !== 'unknown'
              ? { usesSubcontractors: draft.usesSubcontractors === 'yes' }
              : {}),
            ...(notes ? { notes } : {}),
          },
        }),
  };

  const parsed = createBusinessBody.safeParse(request);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
    return { ok: false, refusal: { reason: 'contract', detail } };
  }

  return { ok: true, request };
}

/**
 * The contract's required core of `Business`, pinned by hand because orval
 * emits no response schema for this operation (the `contextQuestionnaire`
 * oneOf — the same generator gap `getChaseResponse` documents in
 * `api/chases.ts`). Only what the success screen stands on is asserted;
 * everything else passes through untyped rather than being re-declared here.
 */
const businessCreated = z
  .object({
    id: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    createdAt: z.string(),
  })
  .passthrough();

export type CreatedBusiness = z.infer<typeof businessCreated>;

/**
 * Creates the client. A 201 whose body has drifted from the contract throws
 * with the field named — it is never reported as a created client, because
 * the caller's success screen would then be asserting something unverified.
 * Problem+json failures propagate as `NtProblemError` and keep their `NT-`
 * code for `errorLabel`.
 */
export async function submitClientIntake(request: BusinessCreateRequest): Promise<CreatedBusiness> {
  const body = unwrapBody(await createBusiness(request));
  const parsed = businessCreated.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`)
      .join('; ');
    throw new Error(`createBusiness answered off-contract — ${detail}`);
  }
  return parsed.data;
}
