/**
 * pipelines/hotfix.mjs — pipeline definition for HOTFIX tickets.
 *
 * WHY: hotfixes have a different failure profile than features. They are
 * usually small, they are usually URGENT (labelled `p0`/`urgent`), and if
 * one goes wrong the blast radius is bigger than the ticket itself.
 * The mitigations are: SMALL scope (one file, one behaviour), SHORT clock
 * (15 min not 25), and — where plausible — the fix goes behind a feature
 * flag so an unattended rollback is one env-var flip instead of a revert.
 *
 * This module is READ by worker.mjs when DAY_SHIFT_FACTORY_ROUTER=1; the
 * defaults below OVERRIDE the corresponding worker defaults for this run
 * only. Anything not set here falls back to the worker's baseline.
 */

export const workType = 'hotfix';

/**
 * Tighter wall clock. A hotfix that can't converge in 15 minutes should
 * escalate to a human, not chew another 10 minutes of Max quota trying.
 */
export const maxIterMinutes = 15;

/** Additional guard rails — deliberately strict. */
export const allowScopeCreep = false;
export const allowNewDeps = false;

/**
 * Appended to the worker's base system prompt BEFORE the ticket spec section
 * (worker.mjs handles the concat). Kept short — the base prompt already has
 * the safety-perimeter + zero-credit + honest-COMPLETE rules; this only adds
 * hotfix-specific tightening.
 */
export const systemPromptAugment = `
## HOTFIX PIPELINE — extra rules on top of the baseline

You are on the **HOTFIX** track. This ticket was routed here because its title
or a label marked it urgent / p0 / hotfix. Extra rules apply:

1. **AT MOST ONE FILE CHANGED.** A hotfix that spans multiple files is a
   feature in disguise — output \`<promise>OUT-OF-SCOPE</promise>\` and stop.
   The exception is adding a colocated test file next to the file you fixed
   (that IS a hotfix, per rule 3 below).

2. **Wall clock is 15 minutes, not 25.** If you are not converging by then,
   the dispatcher kills the process; a partial hotfix landing in the holding
   branch is worse than none. Prefer scope-shrinking to time-extending.

3. **Add a regression test in the SAME commit** that pins the exact bug
   behaviour, if the code you're touching is testable. A hotfix without a
   regression test is how the same bug reaches production twice.

4. **Prefer a feature-flag / env-var gate over an unconditional change**
   when plausible. If the fix can be wrapped in a boolean check on
   \`process.env.<NAME>\` (or an existing flag in \`src/config/\`), do so and
   note the flag name in \`progress.txt\`. Reason: if the hotfix itself
   turns out to introduce a regression, rollback is an env-var flip on
   Render, not a revert PR. Skip the flag ONLY when it would require
   restructuring the call site (which by definition breaks rule 1).

5. **Do NOT add new dependencies.** \`package.json\` is off-limits on this
   track. A hotfix needing a new package is not a hotfix.

6. **Do NOT refactor.** Even a "small cleanup along the way" is banned.
   Every diff line must be defensible as "part of the fix". Reviewers on
   the holding branch will reject drift on the hotfix track.

If any of rules 1-6 forces you off-course, output
\`<promise>OUT-OF-SCOPE</promise>\` — the ticket will be re-triaged as a
regular bug or feature by a human.
`;

/**
 * Optional per-track verification commands the worker MAY run after the
 * baseline \`tsc --noEmit\` + \`vitest run\`. Kept as an array of strings so
 * the worker can log them for the reviewer without executing anything the
 * pipeline definition doesn't approve.
 */
export const verificationCommands = [
  'npx tsc --noEmit',
  'npx vitest run <touched-paths>',
];

/**
 * Human note surfaced in dispatch logs + the eventual PR body so the reviewer
 * can see WHY this ticket ran on the tighter recipe.
 */
export const notes = 'Hotfix track: 15-min cap, single-file rule, prefer feature-flag gating, regression test required if testable.';

export default {
  workType,
  maxIterMinutes,
  allowScopeCreep,
  allowNewDeps,
  systemPromptAugment,
  verificationCommands,
  notes,
};
