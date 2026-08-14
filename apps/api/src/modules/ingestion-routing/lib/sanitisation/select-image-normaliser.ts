import { bootstrapImageNormaliser, type ImageNormaliser } from './guards.js';
import { createSharpImageNormaliser } from './sharp-image-normaliser.js';

export type ImageNormaliserMode = 'fixture' | 'sharp';

/**
 * Config-selected, not import-selected (#23) — the same shape as
 * `selectDocumentStore` and the ingest queue.
 *
 * Takes the MODE rather than `Env`: this library is pure by design (no config,
 * no network, no database), and reaching into the env module here would make it
 * unusable anywhere the app's boot contract has not already been parsed.
 *
 * The fixture is not a lesser version of the real thing. It is what lets the
 * pipeline tests run on hand-built byte sequences that are a valid magic number
 * and nothing else — handing those to sharp would produce a correct refusal and
 * a suite that tests the decoder rather than the pipeline.
 */
export function selectImageNormaliser(mode: ImageNormaliserMode): ImageNormaliser {
  return mode === 'sharp' ? createSharpImageNormaliser() : bootstrapImageNormaliser;
}
