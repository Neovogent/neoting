import { describe, expect, test } from 'vitest';

import { InMemoryAiBudget } from '../../../common/ai-budget.js';
import { replayBedrockMessages } from '../../../common/bedrock-replay.js';
import { BedrockCodingModel } from './bedrock-coding.js';
import { CODING_REPLAY_CASES, CORRECTION_REPLAY_CASES } from './coding-replay-corpus.js';
import { MODEL_MAX_CONFIDENCE } from './coding-instructions.js';

/**
 * **The committed cassettes drive the REAL coding model** — the extraction
 * `replay-extractor.test.ts` argument, one rung over.
 *
 * Everything but the wire runs: the prompt is assembled from the client's chart
 * and their own intake answers, the answer is Zod-parsed, the chart is enforced,
 * the reasoning sanitiser runs, and the spend is metered. Only
 * `messages.create` is served from `fixtures/cassettes/bedrock/`.
 *
 * ⚠ **A miss here is the mechanism working, not a broken test.** The cassette
 * key hashes the request body, so editing the prompt, the tool schema, the
 * model pin or a corpus request orphans every key — and the failure names
 * `pnpm --filter @neoting/api record:cassettes`. Re-record and commit the diff
 * with the change that required it.
 */

function replayModel(): BedrockCodingModel {
  return new BedrockCodingModel({
    region: 'eu-west-2',
    budget: new InMemoryAiBudget(1_000_000),
    client: replayBedrockMessages(),
  });
}

describe('the coding rung, replayed', () => {
  /**
   * ⚠ **Review item 19's own case.** A meat wholesaler invoicing a restaurant
   * escalated with a BLANK category and the note "nothing on this client's chart
   * matches… nothing was guessed at". Nothing on the page says food cost; the
   * restaurant does.
   */
  test('the Aldgate case yields a plausible food code off the CLIENT’S OWN chart, with a confidence and a sentence', async () => {
    const kase = CODING_REPLAY_CASES.find((c) => c.name === 'coding-aldgate-meat-to-restaurant');
    const answer = await replayModel().suggest((kase as (typeof CODING_REPLAY_CASES)[number]).request);

    expect(answer?.outcome).toBe('SUGGEST');
    if (answer?.outcome !== 'SUGGEST') return;
    // On the chart, not invented: the parse refuses anything else.
    const codes = kase?.request.chart.categories.map((category) => category.code) ?? [];
    expect(codes).toContain(answer.categoryCode);
    expect(answer.confidence).toBeGreaterThan(0);
    expect(answer.note.length).toBeGreaterThan(0);
    expect(answer.basis).toBe('INDUSTRY_CONTEXT_REASONING');
  });

  test('⚠ a café bill does NOT escalate — the owner’s +2 / -5 rule, held against the real model', async () => {
    // His own screenshot, 8 Sep 2026: three items on a café bill came back with
    // a blank Category and "nothing on this client's chart matches", while
    // STAFF_WELFARE — keywords "staff refreshments, tea and coffee" — sat on
    // that very chart unchosen. His ruling: a category is worth +2, no category
    // -5, "I need category at any cost". The instructions say so now, and this
    // is the recorded proof that the live model does it.
    //
    // The assertion is deliberately NOT `=== 'STAFF_WELFARE'`. What was ruled
    // is that an everyday purchase gets an ANSWER off the client's own chart —
    // pinning the exact account would fail the day a re-record picks
    // BUSINESS_ENTERTAINING, which is a defensible reading of the same bill and
    // not a regression.
    const kase = CODING_REPLAY_CASES.find((c) => c.name === 'coding-cafe-bill-to-restaurant');
    const answer = await replayModel().suggest((kase as (typeof CODING_REPLAY_CASES)[number]).request);

    expect(answer?.outcome).toBe('SUGGEST');
    if (answer?.outcome !== 'SUGGEST') return;
    const codes = kase?.request.chart.categories.map((category) => category.code) ?? [];
    expect(codes).toContain(answer.categoryCode);
    expect(answer.note.length).toBeGreaterThan(0);
  });

  /**
   * ⚠ **The measurement that put `MODEL_MAX_CONFIDENCE` in the code.** The first
   * live answer to the case above reported **0.97** on a zero-shot categorisation
   * of a brand-new supplier, where the published figures are 62.5% top-1 and
   * ~36% zero-shot, and where this module's own brightest line caps at 0.9. The
   * prompt asks for honesty and got 0.97 anyway — `input_schema` instructs, the
   * parse enforces.
   */
  test('a model’s own confidence is BOUNDED before it reaches a card', async () => {
    const kase = CODING_REPLAY_CASES.find((c) => c.name === 'coding-aldgate-meat-to-restaurant');
    const answer = await replayModel().suggest((kase as (typeof CODING_REPLAY_CASES)[number]).request);
    // The recorded answer says 0.97; what a surface may render does not.
    expect(answer?.confidence).toBeLessThanOrEqual(MODEL_MAX_CONFIDENCE);
  });

  test('a document with nothing to go on still answers with a NAMED reason, never a bare null', async () => {
    const kase = CODING_REPLAY_CASES.find((c) => c.name === 'coding-nothing-to-go-on');
    const answer = await replayModel().suggest((kase as (typeof CODING_REPLAY_CASES)[number]).request);

    expect(answer?.outcome).toBe('ESCALATE');
    expect(answer?.outcome === 'ESCALATE' && answer.reason.length).toBeGreaterThan(0);
  });

  /**
   * The three refusals, all through the real parse, all from one recorded
   * answer. This cassette is synthetic on purpose — a live model cannot be made
   * to misbehave on demand.
   */
  test('⚠ an off-chart code, a borrowed basis and a markup-shaped sentence are all refused', async () => {
    const kase = CODING_REPLAY_CASES.find((c) => c.name === 'coding-hostile-answer');
    const answer = await replayModel().suggest((kase as (typeof CODING_REPLAY_CASES)[number]).request);

    // Refused, and emphatically NOT matched to the code it is one character from.
    expect(answer?.outcome).toBe('ESCALATE');
    expect(answer?.outcome === 'ESCALATE' && answer.reason).toBe('CODE_NOT_ON_CHART');
    expect(JSON.stringify(answer)).not.toContain('COS_FOOD_AND_DRINK');
    // The sentence never reaches a card.
    expect(JSON.stringify(answer)).not.toContain('APPROVED BY HMRC');
  });

  test('every replayed call is metered — a recorded read still costs the firm its pence', async () => {
    const budget = new InMemoryAiBudget(1_000_000);
    const model = new BedrockCodingModel({ region: 'eu-west-2', budget, client: replayBedrockMessages() });
    const kase = CODING_REPLAY_CASES[0] as (typeof CODING_REPLAY_CASES)[number];

    await model.suggest(kase.request);
    expect((await budget.check('prac_replay')).spentPence).toBeGreaterThan(0);
  });
});

describe('the correction second opinion, replayed', () => {
  const opinion = async (name: string) => {
    const kase = CORRECTION_REPLAY_CASES.find((c) => c.name === name);
    return replayModel().secondOpinion((kase as (typeof CORRECTION_REPLAY_CASES)[number]).request);
  };

  /**
   * ⚠ **The case the model earns its keep on.** A document that reads perfectly,
   * and a supplier typed onto it that names somebody else. Arithmetic cannot see
   * it and the deterministic layer has nothing to check it against.
   */
  test('a supplier typed onto a document that names a different party is ABSENT', async () => {
    expect(await opinion('opinion-supplier-not-on-document')).toEqual({ supplier: 'ABSENT', total: null, category: null });
  });

  /** Item 22's own shape: an on-chart account that argues with what was bought. */
  test('a window clean coded to travel and subsistence is DISSONANT', async () => {
    expect(await opinion('opinion-category-dissonant')).toEqual({ supplier: null, total: null, category: 'DISSONANT' });
  });

  /**
   * ⚠ **The recorded answer is NOT the one item 47's brief predicted, and it is
   * the right one.** Shown a document the pipeline read NOTHING off, the model
   * says it cannot tell rather than that the values are absent — and the
   * deterministic layer already covers this exact shape with *"this does not
   * appear to be a financial document"*. Two layers not saying the same thing
   * twice is what keeps a warning worth reading.
   */
  test('a document nothing was read off is NOT_CHECKABLE, and raises no check at all', async () => {
    expect(await opinion('opinion-selfie-fabricated-fields')).toEqual({ supplier: 'NOT_CHECKABLE', total: 'NOT_CHECKABLE', category: null });
  });

  test('a correction the document supports raises NOTHING — which is what keeps the check credible', async () => {
    const verdicts = await opinion('opinion-correction-agrees');
    expect(verdicts?.supplier).toBe('PRESENT');
    expect(verdicts?.category).toBe('CONSISTENT');
  });
});
