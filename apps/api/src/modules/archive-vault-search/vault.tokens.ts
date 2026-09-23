/**
 * DI tokens for the Document Vault (D51).
 *
 * In their own file so the controller and the module can share them without the
 * controller importing the module — which would close a cycle, since the module
 * declares the controller.
 */
export const PRISMA = 'VAULT_PRISMA';
export const DOCUMENT_STORE = 'VAULT_DOCUMENT_STORE';
export const DRIVE_FETCH = 'VAULT_DRIVE_FETCH';
export const DRIVE_CONNECTION_CONFIG = 'DRIVE_CONNECTION_CONFIG';
export const VAULT_SERVICE = 'VAULT_SERVICE';
export const DRIVE_CONNECTIONS = 'DRIVE_CONNECTIONS';
