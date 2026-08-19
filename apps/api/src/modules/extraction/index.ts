/**
 * The public seam of extraction (Boundaries, apps/api/CLAUDE.md).
 *
 * The ingest processor (ingestion-routing) runs extraction after it persists a
 * document, so it needs the step's interface to type against and a fixture to
 * test with; the worker composition root builds the real one. Everything else in
 * this directory is internal, and the boundary is lint-enforced
 * (`neoting/no-cross-module-internals`).
 */
export type { DocumentExtractor } from './document-extractor.js';
export {
  type ExtractionCompletion,
  type ExtractionInput,
  type ExtractionStep,
  PrismaExtractionStep,
  RecordingExtractionStep,
} from './extraction-pipeline.js';
export { selectExtractor } from './select-extractor.js';
