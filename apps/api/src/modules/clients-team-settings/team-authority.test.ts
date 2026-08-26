import { expect, test } from 'vitest';

import { WorkspaceRole } from '@neoting/contracts/model';

import { BUSINESS_LEVEL_ROLES, canCompose, canRelease, isBusinessLevelRole, RELEASE_ROLE } from './team-authority.js';

const EVERY_ROLE = Object.values(WorkspaceRole);

test('D44: exactly one role releases, and it is the practice super admin', () => {
  expect(RELEASE_ROLE).toBe('PRACTICE_ADMIN');
  expect(EVERY_ROLE.filter(canRelease)).toEqual(['PRACTICE_ADMIN']);
});

test('D44: everyone composes — a team that cannot draft is not the product', () => {
  expect(EVERY_ROLE.every(canCompose)).toBe(true);
});

test('a client workspace grants only the three business-level roles', () => {
  expect(BUSINESS_LEVEL_ROLES).toEqual(['BUSINESS_ADMIN', 'USER_ADMIN', 'BUSINESS_STANDARD']);
  expect(EVERY_ROLE.filter(isBusinessLevelRole)).toEqual(['BUSINESS_ADMIN', 'USER_ADMIN', 'BUSINESS_STANDARD']);
});

test('the practice-level roles are refused on the client team list, including CLIENT_ADMIN', () => {
  // CLIENT_ADMIN is a PRACTICE-side role (SoT §3.3: "all clients, no practice-
  // subscription control"), and the contract names only three roles for this
  // route. It is spelled out because the name reads like a client role.
  expect(isBusinessLevelRole(WorkspaceRole.PRACTICE_ADMIN)).toBe(false);
  expect(isBusinessLevelRole(WorkspaceRole.CLIENT_ADMIN)).toBe(false);
  expect(isBusinessLevelRole(WorkspaceRole.PRACTICE_STANDARD)).toBe(false);
});

test('releasing is not implied by being able to grant access', () => {
  // A USER_ADMIN manages the client's own people and still cannot release —
  // the two authorities are separate, which is the whole of D44.
  expect(isBusinessLevelRole(WorkspaceRole.USER_ADMIN)).toBe(true);
  expect(canRelease(WorkspaceRole.USER_ADMIN)).toBe(false);
  expect(canRelease(WorkspaceRole.BUSINESS_ADMIN)).toBe(false);
});
