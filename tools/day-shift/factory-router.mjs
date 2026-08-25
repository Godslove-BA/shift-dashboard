/**
 * factory-router.mjs — day-shift work-type classifier.
 *
 * WHY: today every safe ticket runs through ONE worker recipe (same prompt,
 * same 25-min wall clock, same scope rules) regardless of whether it's a
 * chore (a docs typo) or a bug (needs a regression test). That's the
 * Cognition/Devin-style "one big agent" trap — the more shapes of work you
 * pour through one funnel, the worse the funnel fits any of them.
 *
 * This module is the first half of the Agentic Developer Workflow (ADW)
 * "Factory Router → specialized pipeline" pattern: read a GitHub issue's
 * title + labels + body, decide what SHAPE of work it is, hand it off to a
 * per-shape pipeline definition (see tools/day-shift/pipelines/). Cheap,
 * deterministic, pure JS — no LLM call — so it's free to run on every ticket
 * and easy to unit-test.
 *
 * Contract:
 *   classify(issue) → { workType, matched, describe }
 *     workType: 'hotfix' | 'feature' | 'bug' | 'chore' | 'unknown'
 *     matched:  { source: 'title'|'label'|'default', pattern, value }
 *     describe: short human string for structured logging
 *
 * 'unknown' is the honest verdict when nothing matches; the pipeline layer
 * treats it as 'feature' (widest, safest default) but keeps the label so we
 * can measure how much of the queue we're actually classifying.
 *
 * Not implemented here (deliberately):
 *   - LLM-based intent parsing. It would be more accurate on messy titles
 *     but costs tokens on EVERY ticket in EVERY dispatch and gives us a
 *     hidden dependency we can't easily unit-test. Rules first; add an LLM
 *     tiebreaker later if the 'unknown' rate stays high.
 */

// Precompiled title-prefix regexes. Conventional-commit-ish: allow an
// optional scope like `hotfix(chat):` or `feat(business):`, tolerate a leading
// bracketed marker like `[urgent]`, and be case-insensitive because humans
// aren't consistent. The exact order these are tested in `classify()` IS the
// precedence order — see the doc-comment on `classify()`.
const TITLE_HOTFIX = /^\s*(?:\[[^\]]+\]\s*)?(?:hotfix|fix\s*\(\s*hotfix\s*\))(?:\s*\([^)]*\))?\s*:/i;
const TITLE_FEATURE = /^\s*(?:\[[^\]]+\]\s*)?(?:feat(?:ure)?)(?:\s*\([^)]*\))?\s*:/i;
const TITLE_BUG = /^\s*(?:\[[^\]]+\]\s*)?(?:fix|bug|bugfix)(?:\s*\([^)]*\))?\s*:/i;
const TITLE_CHORE = /^\s*(?:\[[^\]]+\]\s*)?(?:chore|docs?|test|tests|refactor|style|ci|build)(?:\s*\([^)]*\))?\s*:/i;

// Label allowlists. `.trim().toLowerCase()`-normalized before comparison; we
// accept a few common spellings + spacing/dash variants (`p0`, `P-0`, `p 0`).
const LABELS_HOTFIX = new Set(['hotfix', 'urgent', 'p0', 'p-0', 'critical', 'sev-1', 'sev1']);
const LABELS_FEATURE = new Set(['feature', 'enhancement', 'new-feature']);
const LABELS_BUG = new Set(['bug', 'defect', 'regression']);
const LABELS_CHORE = new Set(['chore', 'documentation', 'docs', 'test', 'tests', 'refactor', 'ci', 'build']);

/**
 * Normalise GitHub's label list (which is either strings OR `{name, color, …}`
 * objects depending on the endpoint that produced it) into a lowercase, dash-
 * collapsed string array. Also collapses whitespace to dashes so `P 0` → `p-0`.
 */
function normaliseLabels(issue) {
  const raw = Array.isArray(issue?.labels) ? issue.labels : [];
  return raw
    .map((l) => (typeof l === 'string' ? l : l?.name || ''))
    .map((s) => String(s).trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean);
}

/**
 * Try each title regex in the fixed precedence order below. Hotfix wins over
 * feature/bug/chore because a `hotfix:` title MUST route to the hotfix pipeline
 * even if the body reads like a feature description.
 */
function classifyByTitle(title) {
  const t = String(title || '');
  if (TITLE_HOTFIX.test(t)) return { workType: 'hotfix', pattern: 'title:hotfix' };
  if (TITLE_FEATURE.test(t)) return { workType: 'feature', pattern: 'title:feat' };
  if (TITLE_BUG.test(t)) return { workType: 'bug', pattern: 'title:fix' };
  if (TITLE_CHORE.test(t)) return { workType: 'chore', pattern: 'title:chore' };
  return null;
}

/**
 * Precedence for labels matches title precedence: hotfix > feature > bug > chore.
 * A ticket labelled BOTH `bug` and `hotfix` is a hotfix (that's the point of the
 * hotfix label). A ticket labelled BOTH `feature` and `bug` is a feature —
 * matches how the human triager would treat "new feature that fixes a shortcoming".
 */
function classifyByLabels(labels) {
  for (const l of labels) if (LABELS_HOTFIX.has(l)) return { workType: 'hotfix', pattern: `label:${l}` };
  for (const l of labels) if (LABELS_FEATURE.has(l)) return { workType: 'feature', pattern: `label:${l}` };
  for (const l of labels) if (LABELS_BUG.has(l)) return { workType: 'bug', pattern: `label:${l}` };
  for (const l of labels) if (LABELS_CHORE.has(l)) return { workType: 'chore', pattern: `label:${l}` };
  return null;
}

/**
 * Classify an issue.
 *
 * Precedence (first match wins):
 *   1. Title prefix — most authoritative because the ticket author picked it
 *      (`hotfix:`, `feat:`, `fix:`, `chore:`, `docs:`, `test:`).
 *   2. Labels — a triager may have added `hotfix`/`bug`/`enhancement`/`chore`
 *      after the fact.
 *   3. Default: 'unknown'. Downstream pipelines map this to the widest
 *      recipe ('feature') but we KEEP the 'unknown' verdict for telemetry.
 *
 * Body content intentionally isn't parsed — free-text bodies are too noisy
 * for a deterministic router; false positives would misroute tickets and
 * that costs more than routing conservatively.
 */
export function classify(issue) {
  const title = issue?.title || '';
  const labels = normaliseLabels(issue);

  const titleHit = classifyByTitle(title);
  if (titleHit) return { workType: titleHit.workType, matched: { source: 'title', ...titleHit, value: title.slice(0, 80) } };

  const labelHit = classifyByLabels(labels);
  if (labelHit) return { workType: labelHit.workType, matched: { source: 'label', ...labelHit, value: labels.join(',') } };

  return { workType: 'unknown', matched: { source: 'default', pattern: 'no-match', value: title.slice(0, 80) } };
}

/**
 * Short human-readable log line, safe to pass straight into `log.info`.
 * e.g. "#1234 → hotfix (title:hotfix)". Kept separate from `classify()` so
 * callers who want the raw verdict don't pay a string-concat cost.
 */
export function describeClassification(issue) {
  const c = classify(issue);
  const num = issue?.number ?? '?';
  return `#${num} → ${c.workType} (${c.matched.source}:${c.matched.pattern})`;
}

/**
 * Named export map so callers can `import { WORK_TYPES } from './factory-router.mjs'`
 * and iterate rather than hardcoding strings.
 */
export const WORK_TYPES = Object.freeze(['hotfix', 'feature', 'bug', 'chore', 'unknown']);
