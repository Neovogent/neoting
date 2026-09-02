/**
 * The public seam of clients-team-settings (Boundaries, `apps/api/CLAUDE.md`).
 *
 * What is exported here is the whole of what other modules' code may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional.
 *
 * Three consumers are already named, and each is the reason a name below is on
 * the seam rather than inside a service:
 *
 * - **A6 · the coding engine** reads the business-type profile.
 *   `readBusinessProfile` parses the `businesses.context_questionnaire` column;
 *   `profileForModel` renders it **wrapped** in `<untrusted_content>` so the
 *   wrapping is a function you call rather than a rule you remember.
 * - **A12 · the release gate** asks "may this role release?". `canRelease` is
 *   D44's answer, defined once — A12 enforcing a role it derived independently
 *   is two definitions of "super admin" free to drift.
 * - **A2 · the portal's onboarding session** verifies the setup token the
 *   registration email carried. It must hash the presented `setupToken` with
 *   `hashSetupToken` and look it up by `invites.token_hash`; two hashings is a
 *   sign-in that works on one side and not the other.
 */

// The business-type profile — D47's substitute for a chart of accounts (§24.4).
export {
  BUSINESS_PROFILE_COLUMN,
  type BusinessTypeProfile,
  BusinessTypeProfileSchema,
  profileForModel,
  readBusinessProfile,
  toStoredProfile,
} from './business-profile.js';

// D44 — compose is everyone, release is the super admin.
export {
  BUSINESS_LEVEL_ROLES,
  canCompose,
  canRelease,
  INVITABLE_PRACTICE_ROLES,
  isBusinessLevelRole,
  isPracticeLevelRole,
  RELEASE_ROLE,
} from './team-authority.js';

// The setup link. `mintSetupToken` and `buildSetupLink` are intake's; the
// verifier needs `hashSetupToken` and `setupTokenHashEquals`.
export {
  buildInviteLink,
  buildSetupLink,
  DEFAULT_APP_ORIGIN,
  hashSetupToken,
  INVITE_LINK_PATH,
  mintSetupToken,
  SETUP_LINK_PATH,
  SETUP_LINK_TTL_DAYS,
  setupLinkExpiry,
  setupTokenHashEquals,
} from './setup-link.js';

// The services and their DI tokens, so a consuming module can
// `imports: [ClientsTeamSettingsModule]` and `@Inject(...)`.
export { ClientIntakeService } from './client-intake.service.js';
export { ClientsTeamSettingsModule } from './clients-team-settings.module.js';
export { TeamService } from './team.service.js';
export { CLIENT_INTAKE_SERVICE, TEAM_SERVICE } from './tokens.js';
