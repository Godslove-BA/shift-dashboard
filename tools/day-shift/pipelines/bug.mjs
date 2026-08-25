/**
 * pipelines/bug.mjs — pipeline definition for BUG tickets.
 *
 * WHY: bugs are almost always a reproduce → diagnose → patch → verify
 * loop, and the ONE thing that makes a bug fix survive future refactors
 * is a regression test pinning the failing behaviour. Without it, the
 * same bug reaches production twice — a pattern this codebase has
 * repeatedly hit. So the bug pipeline's core delta over the baseline is
 * "test first (or in the same PR), not later".
 *
 * Same 25-min budget as features; scope stays tight (one bug, one
 * behaviour, no adjacent cleanups).
 */

export const workType = 'bug';

export const maxIterMinutes = null; // baseline (25 min)
export const allowScopeCreep = false;
export const allowNewDeps = false;

export const systemPromptAugment = `
## BUG PIPELINE — extra rules on top of the baseline

You are on the **BUG** track. This ticket was routed here because its title
or a label marked it a defect / regression. Extra rules apply:

1. **Reproduce first, then patch.** Before editing production code, write
   a failing test (unit \`vitest\` for logic, e2e Playwright spec for a
   user-visible flow) that FAILS with today's code. Only then patch. If
   the test passes without your patch, you're testing the wrong thing —
   iterate the repro before touching src.

2. **The regression test lives in the SAME PR as the fix.** No "will add
   a test later" — the whole point of the bug pipeline is that a fix
   without a pin re-regresses. If the behaviour is genuinely untestable
   in isolation (e.g. it needs a paid provider render, or a full staging
   browser session), spell that out in \`progress.txt\` and add the
   thinnest possible characterization test that pins the boundary you
   CAN reach.

3. **Do NOT expand scope.** Fix the exact bug the ticket names. A
   related bug you noticed while diagnosing goes in a separate follow-up
   ticket (comment it on the tracker; do not silently fix it here).
   Drift is the #1 cause of holding-branch rejections.

4. **Include the root cause in \`progress.txt\`.** The COMPLETE block
   should state (a) what the user did that triggered the bug, (b) which
   line/branch of code produced the wrong behaviour, and (c) why the
   patch fixes it. This is what the desk-review reader needs to trust
   the fix.

If the ticket can't be reproduced with today's code, output
\`<promise>OUT-OF-SCOPE</promise>\` with the repro attempts in
\`progress.txt\` — leave it for a human to reproduce.
`;

export const verificationCommands = [
  'npx tsc --noEmit',
  'npx vitest run <touched-paths>',
];

export const notes = 'Bug track: 25-min cap, MUST add regression test in same PR, reproduce-first workflow.';

export default {
  workType,
  maxIterMinutes,
  allowScopeCreep,
  allowNewDeps,
  systemPromptAugment,
  verificationCommands,
  notes,
};
