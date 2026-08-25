/**
 * pipelines/chore.mjs — pipeline definition for CHORE tickets.
 *
 * WHY: chores (docs typos, test-only refactors, lint sweeps, CI tweaks)
 * are the ONE ticket shape where a full worker recipe is overkill. They
 * should not touch runtime logic, should not need a 25-minute clock,
 * and should not need e2e verification. Running them on the baseline
 * feature recipe just burns Max quota for no additional safety.
 *
 * The tightening here is:
 *   - 10-minute wall clock (usually 2-5 minutes is enough)
 *   - runtime code under src (any .ts/.tsx/.js/.jsx) is OFF-LIMITS
 *   - lint / typecheck only; no vitest / e2e requirement
 *
 * A chore that TURNS OUT to need a runtime edit auto-escalates to
 * OUT-OF-SCOPE so it can be re-triaged as a bug/feature.
 */

export const workType = 'chore';

export const maxIterMinutes = 10;
export const allowScopeCreep = false;
export const allowNewDeps = false;

export const systemPromptAugment = `
## CHORE PIPELINE — extra rules on top of the baseline

You are on the **CHORE** track. This ticket was routed here because its
title or a label marked it a chore / docs / tests / lint / CI change.
Extra rules apply:

1. **DO NOT TOUCH RUNTIME LOGIC.** Runtime = anything under \`src/\` that
   ships to the browser or server at runtime (\`*.ts\`, \`*.tsx\`, \`*.js\`,
   \`*.jsx\` excluding \`*.test.*\` / \`*.spec.*\`), plus \`server.js\`,
   \`server/\`, and route files. If the ticket needs a runtime edit,
   output \`<promise>OUT-OF-SCOPE</promise>\` — it's not a chore.

2. **Allowed surfaces only:**
   - \`docs/**\`, \`*.md\`, \`README*\`, \`CHANGELOG*\` (but NEVER
     \`CHANGELOG.md\` — it is auto-generated, per the global rule).
   - \`*.test.*\`, \`*.spec.*\`, files under \`e2e/\` or \`__tests__/\`
     (test-only changes).
   - Config: \`.eslintrc*\`, \`tsconfig*.json\`, \`vitest.config.*\`,
     \`playwright.config.*\`, files under \`.github/workflows/\` for CI
     tweaks, \`.editorconfig\`, \`.gitignore\`.
   - \`package.json\` ONLY to bump dev-dependencies for lint/test tooling
     (never runtime deps; never a new dep).

3. **Wall clock is 10 minutes.** Chores are small by nature. If you're
   at 10 minutes on a chore, output \`<promise>STUCK</promise>\` — the
   ticket was misclassified.

4. **Verification is lint + typecheck only** (\`npx tsc --noEmit\`,
   \`npx eslint <touched>\` if lint config present). You do NOT need to
   run vitest or Playwright — chores don't change behaviour, so there is
   nothing behavioural to verify.

5. **No new dependencies** (per the shared rule). Even a dev-dep bump
   should be a separate ticket unless the ticket explicitly asks for it.

If the ticket looks like a chore but is actually a feature/bug in
disguise (e.g. "clean up X" that requires runtime edits), output
\`<promise>OUT-OF-SCOPE</promise>\` and note the reason in
\`progress.txt\`.
`;

export const verificationCommands = [
  'npx tsc --noEmit',
  'npx eslint <touched-paths>',
];

export const notes = 'Chore track: 10-min cap, docs/test/config only, runtime code forbidden, lint+typecheck verification.';

export default {
  workType,
  maxIterMinutes,
  allowScopeCreep,
  allowNewDeps,
  systemPromptAugment,
  verificationCommands,
  notes,
};
