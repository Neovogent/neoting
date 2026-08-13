/**
 * Team Guideline §4. The PR title is what survives (squash-merge takes it),
 * so this runs against the title in CI as well as against local commits.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf', 'ci'],
    ],
    // Scope = module or area (§4). Not enforced as an enum because module
    // names move; enforced as "present and lowercase".
    'scope-empty': [2, 'never'],
    'scope-case': [2, 'always', 'lower-case'],
    'subject-case': [2, 'always', 'lower-case'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 72],
  },
};
