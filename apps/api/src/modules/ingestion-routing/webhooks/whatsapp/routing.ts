/**
 * The sender-mapping decision (SoT §4 Stage 1). A WhatsApp number maps to zero,
 * one, or many client workspaces:
 *  - one   → routed straight to that workspace;
 *  - many  → the "Which company?" prompt;
 *  - none  → the Unrouted queue (never silently dropped).
 *
 * Pure over a supplied mapping. Persistence lives behind a repository later;
 * today this adds no database dependency (issue #9: no Prisma).
 */
export type RoutingDecision =
  | { readonly kind: 'matched'; readonly businessId: string }
  | { readonly kind: 'multiple'; readonly candidateBusinessIds: readonly string[] }
  | { readonly kind: 'unrouted'; readonly reason: string };

export function decideRouting(
  senderWaId: string,
  mappings: ReadonlyMap<string, readonly string[]>,
): RoutingDecision {
  const businesses = mappings.get(senderWaId) ?? [];
  const [first] = businesses;
  if (businesses.length === 1 && first !== undefined) {
    return { kind: 'matched', businessId: first };
  }
  if (businesses.length > 1) {
    return { kind: 'multiple', candidateBusinessIds: businesses };
  }
  return { kind: 'unrouted', reason: `No workspace is mapped to sender ${senderWaId}.` };
}
