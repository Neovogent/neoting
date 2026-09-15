/**
 * DI tokens for the ledger connection surface (D50).
 *
 * Its own file rather than a member of `publishing/tokens.ts`: that module's
 * header says each module declares its own symbols, and the connection surface
 * is a distinct composition unit inside publishing — the read service and the
 * adapter factory have no business being reachable from the same token bag.
 */
export const LEDGER_CONNECTIONS_SERVICE = Symbol('PUBLISHING_LEDGER_CONNECTIONS_SERVICE');
