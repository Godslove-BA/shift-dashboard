/**
 * pipelines/feature.mjs — pipeline definition for FEATURE tickets.
 *
 * WHY: features are the widest / most exploratory shape of work — a small
 * new UI component, a small backend endpoint, a wired-up integration. They
 * need the full 25-minute budget and the SAME rules as today's default
 * worker; this pipeline is intentionally a "no override" module so we can
 * still route explicitly (for logging + PR-body attribution) without
 * behaviour-changing anything. If we later find features need their own
 * augment (e.g. "always add a smoke test"), it lives here.
 *
 * IMPORTANT: 'unknown' also routes here (see factory-router.mjs) — this is
 * the safe default when the classifier can't tell.
 */

export const workType = 'feature';

/**
 * Full baseline clock. Explicitly `null` (not `undefined`) so the worker
 * knows this pipeline is deliberately choosing the default, and hasn't
 * simply forgotten to set it — matches the shape enforced by the pipeline
 * tests.
 */
export const maxIterMinutes = null;

/** Baseline scope rules — same as the worker's default. */
export const allowScopeCreep = false;
export const allowNewDeps = false;

/**
 * Empty string means "append nothing to the base prompt" — the baseline
 * rules in prompts/worker-system.md already cover feature work. Kept as an
 * explicit empty string (not null) so the pipeline-shape test can enforce
 * `typeof systemPromptAugment === 'string'` uniformly across all pipelines.
 */
export const systemPromptAugment = '';

export const verificationCommands = [
  'npx tsc --noEmit',
  'npx vitest run <touched-paths>',
];

export const notes = 'Feature track (also handles unknown): 25-min cap, baseline worker rules unchanged.';

export default {
  workType,
  maxIterMinutes,
  allowScopeCreep,
  allowNewDeps,
  systemPromptAugment,
  verificationCommands,
  notes,
};
