import { TextractClient } from '@aws-sdk/client-textract';

import type { DocumentOcrReader } from './document-ocr.js';
import { TextractOcrReader } from './textract-ocr-reader.js';

/**
 * The OCR reader, chosen by CONFIG rather than by import — the same seam
 * discipline as `selectExtractor` / `selectDocumentStore`.
 *
 * Returns `undefined` for `none`, and that is a real answer rather than a
 * degraded one: a CSV or XLSX statement still imports, and a model still reads
 * an image or a PDF directly. Only a PDF STATEMENT is refused, with a message
 * saying the reader is not configured. The alternative — quietly skipping the
 * document — is the silent loss D41 exists to prevent.
 *
 * ⚠ There is deliberately no fixture implementation. A fake OCR reader would
 * return invented text for a real client's document, which is the same class of
 * hazard `FallbackExtractor` was deleted for.
 */
export function selectOcrReader(
  env: {
    readonly STATEMENT_READER: 'none' | 'textract';
    /**
     * ⚠ The BUCKET's region, not a Textract-specific one, and deliberately so:
     * the asynchronous path hands Textract an S3 object, and Textract will only
     * read a bucket in its OWN region. Two knobs here would be two ways to get
     * that wrong.
     */
    readonly S3_REGION: string;
    readonly S3_BUCKET_DOCUMENTS: string;
  },
  logger?: { log(m: string): void; warn(m: string): void },
): DocumentOcrReader | undefined {
  if (env.STATEMENT_READER === 'none') return undefined;
  return new TextractOcrReader({
    client: new TextractClient({ region: env.S3_REGION }),
    bucket: env.S3_BUCKET_DOCUMENTS,
    ...(logger === undefined ? {} : { logger }),
  });
}
