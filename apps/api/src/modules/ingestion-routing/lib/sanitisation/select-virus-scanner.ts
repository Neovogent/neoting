import { type ClamdOptions, createClamdVirusScanner } from './clamd-virus-scanner.js';
import { fixtureVirusScanner, type VirusScanner } from './virus-scan.js';

export type VirusScannerMode = 'fixture' | 'clamd';

/**
 * Config-selected, not import-selected — the same shape as
 * `selectImageNormaliser` and `selectDocumentGuard`, and for the same reason: a
 * machine without a clamd to talk to still runs the suite, and the choice is
 * visible in configuration rather than buried in an import graph.
 *
 * Takes the MODE and the connection details rather than `Env`: this library is
 * pure by design and must not reach into the env module.
 *
 * ⚠ The fixture is NOT a weaker scanner; it is NOT A SCANNER. It recognises the
 * 68-byte EICAR test string and nothing else, which is enough to prove the
 * pipeline's step-4 plumbing and nothing more. `VIRUS_SCANNER=fixture` means
 * "nothing is being scanned", and the worker says so at boot.
 */
export function selectVirusScanner(mode: VirusScannerMode, clamd: ClamdOptions = {}): VirusScanner {
  return mode === 'clamd' ? createClamdVirusScanner(clamd) : fixtureVirusScanner;
}
