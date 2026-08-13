#!/usr/bin/env bash
#
# Locks `main` so that only Shakib and Mubasshir can push to it, and only their
# review satisfies the approval requirement (via CODEOWNERS).
#
# Idempotent — safe to re-run. Run it after any change to org membership,
# repository collaborators, or .github/CODEOWNERS.
#
#   bash .github/scripts/apply-branch-protection.sh
#
# REQUIRES: the repo is public, OR the Neovogent org is on GitHub Team or
# higher. On the free plan with a private repo the API returns 403 and NONE of
# this is enforceable — see the failure message at the bottom.
#
# Requires `gh` authenticated as a repository admin. No jq — `gh --jq` only.

set -euo pipefail

REPO="Neovogent/neoting"
BRANCH="main"

# The only people who may push to main and whose approval counts.
# Keep this list identical to the `*` line in .github/CODEOWNERS.
OWNERS=("shakibbinkabir" "MubasshirrKan")

# Status checks that must pass. Must match the job name in
# .github/workflows/check.yml exactly, or the gate silently never applies.
CHECKS=("check")

command -v gh >/dev/null || { echo "gh not found (Windows: C:\\Program Files\\GitHub CLI)"; exit 1; }

# "a" "b" -> "a","b"
quoted_csv() {
  local out="" item
  for item in "$@"; do out="${out:+$out,}\"$item\""; done
  printf '%s' "$out"
}

OWNERS_CSV=$(quoted_csv "${OWNERS[@]}")
CHECKS_CSV=$(quoted_csv "${CHECKS[@]}")

echo "==> Verifying the named owners can actually push to $REPO"
for u in "${OWNERS[@]}"; do
  perm=$(gh api "repos/$REPO/collaborators/$u/permission" --jq '.permission' 2>/dev/null || echo "NONE")
  case "$perm" in
    admin|write|maintain) echo "    ok   $u ($perm)" ;;
    *) echo "    FAIL $u has '$perm' — GitHub rejects push restrictions naming a user without write access."; exit 1 ;;
  esac
done

echo "==> Flagging anyone else who can currently push"
gh api "repos/$REPO/collaborators" --paginate \
  --jq '.[] | select(.role_name == "admin" or .role_name == "write" or .role_name == "maintain") | .login + " (" + .role_name + ")"' \
| while read -r line; do
    login="${line%% *}"
    case " ${OWNERS[*]} " in
      *" $login "*) ;;
      *) echo "    NOTE $line can push today; enforce_admins closes this once protection applies." ;;
    esac
  done

echo "==> Applying branch protection to $REPO@$BRANCH"
# enforce_admins=true is the load-bearing flag. Without it, EVERY repository
# admin bypasses the restrictions below, which is exactly the hole we are
# closing — TheRakib and any future admin included. With it on, the `users`
# restriction is the sole gate, so the two named owners still merge normally.
if ! gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
     -H "Accept: application/vnd.github+json" --input - > /dev/null <<JSON
{
  "required_status_checks": { "strict": true, "contexts": [$CHECKS_CSV] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": true,
    "dismissal_restrictions": { "users": [$OWNERS_CSV], "teams": [] }
  },
  "restrictions": { "users": [$OWNERS_CSV], "teams": [], "apps": [] },
  "required_linear_history": true,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
then
  echo
  echo "FAILED. If this was a 403 'Upgrade to GitHub Pro':"
  echo "  Neovogent is on the FREE plan and $REPO is private. GitHub does not"
  echo "  offer branch protection or rulesets in that combination. Nothing in"
  echo "  this repo can enforce the rule until the org moves to GitHub Team."
  echo "  Until then the only real control is collaborator access level:"
  echo "  demote everyone except ${OWNERS[*]} to 'read'."
  exit 1
fi

echo "==> Verifying CODEOWNERS resolves (unresolvable owners are ignored silently)"
errs=$(gh api "repos/$REPO/codeowners/errors" --jq '.errors | length' 2>/dev/null || echo "?")
if [ "$errs" = "0" ]; then
  echo "    ok   no CODEOWNERS errors"
else
  echo "    WARN $errs CODEOWNERS error(s) — run: gh api repos/$REPO/codeowners/errors"
fi

echo "==> Effective settings"
gh api "repos/$REPO/branches/$BRANCH/protection" --jq '{
  push_allowed_users: [.restrictions.users[].login],
  required_approvals: .required_pull_request_reviews.required_approving_review_count,
  code_owner_review_required: .required_pull_request_reviews.require_code_owner_reviews,
  admins_can_bypass: (.enforce_admins.enabled | not),
  force_push: .allow_force_pushes.enabled,
  deletion: .allow_deletions.enabled
}'

echo
echo "Done. main is locked to: ${OWNERS[*]}"
