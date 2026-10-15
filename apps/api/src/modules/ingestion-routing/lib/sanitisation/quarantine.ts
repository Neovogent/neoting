import type { Channel } from './channels.js';

/**
 * Quarantine (SoT §4 Stage 1: "failures quarantine with an operator alert and a
 * plain-language message to the submitter"; runbook Step 8; clamav.tf §1).
 *
 * When the virus scan FLAGS a file, the pipeline refuses it with a visible
 * `virus_detected` rejection — that is the message to the submitter — and hands
 * the ORIGINAL bytes here. The real implementation writes them to the
 * quarantine bucket, whose EventBridge rule is the operator alert
 * (`nt-<env>-av-quarantine-write`) and whose 90-day lifecycle is the evidence
 * retention. The bytes stay available for forensics without ever becoming a
 * `documents` row or an object the worker can read back.
 *
 * Interface + fixture, like `VirusScanner`: the pipeline is a pure library and
 * the default does nothing, so unit tests and a laptop run offline. The real
 * writer lives in `storage/s3-quarantine.ts` and is config-selected by
 * `QUARANTINE_BUCKET`.
 */

export interface QuarantineSample {
  /** The bytes exactly as submitted — pre-normalisation, nothing stripped. */
  readonly bytes: Buffer;
  /** SHA-256 of `bytes`; the content-addressed key, and how an analyst finds the row's event. */
  readonly sha256: string;
  readonly channel: Channel;
  /** The scanner's signature name, when it gave one. */
  readonly signature?: string;
}

export interface Quarantine {
  put(sample: QuarantineSample): Promise<void>;
}

/** Offline default: a flagged file is refused and nothing is kept. */
export const noQuarantine: Quarantine = {
  async put(): Promise<void> {
    /* nothing to store offline */
  },
};

/** A test fixture that remembers what it was handed. */
export interface RecordingQuarantine extends Quarantine {
  readonly samples: QuarantineSample[];
}

export function recordingQuarantine(): RecordingQuarantine {
  const samples: QuarantineSample[] = [];
  return {
    samples,
    async put(sample: QuarantineSample): Promise<void> {
      samples.push(sample);
    },
  };
}
