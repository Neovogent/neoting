/**
 * Virus-scan hook (Governance §11.4, step 4). This is the interface only —
 * the concrete scanner (ClamAV + provider-side) is wired later behind it.
 *
 * A `fixtureVirusScanner` is provided so the pipeline runs fully offline
 * (the app defaults to fixture mode, no cloud keys) and so tests can drive
 * the standard EICAR test string through the same interface a real scanner
 * uses. The EICAR string is an industry-standard, harmless AV test pattern.
 */

export interface ScanVerdict {
  readonly infected: boolean;
  /** The signature name a scanner reports; present when `infected`. */
  readonly signature?: string;
}

export interface VirusScanner {
  scan(bytes: Buffer): Promise<ScanVerdict>;
}

/** The EICAR standard anti-virus test string (not a real virus). */
export const EICAR_TEST_STRING =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Offline fixture scanner: flags any payload containing the EICAR test string
 * and passes everything else. Real scanning is a swap of this dependency, not
 * a change to the pipeline.
 */
export const fixtureVirusScanner: VirusScanner = {
  async scan(bytes: Buffer): Promise<ScanVerdict> {
    const infected = bytes.includes(Buffer.from(EICAR_TEST_STRING, 'latin1'));
    return infected ? { infected: true, signature: 'EICAR-Test-Signature' } : { infected: false };
  },
};
