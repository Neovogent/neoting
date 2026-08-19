import type { Env } from '../../config/env.js';
import { DemoSmsSender, type SmsSender } from './sms-sender.js';

/**
 * Pick the SMS sender from config — never by import, the house pattern shared
 * with `selectExtractor` / `selectMediaFetcher` / `selectDocumentStore`. `demo`
 * is the only value today (METH_MODE Stage 8); Twilio lands behind the same seam
 * post-demo.
 */
export function selectSmsSender(_env: Pick<Env, 'SMS_SENDER'>): SmsSender {
  // Only `demo` exists, and the enum makes it the only value the type admits, so
  // the switch is a single arm — kept as a switch so adding `twilio` is a
  // compile-guided edit, not a search for the call site.
  return new DemoSmsSender();
}
