/**
 * schema.mjs - JSDoc types for the Agent Brain persistent per-ticket record.
 *
 * WHY THIS FILE EXISTS
 * The day-shift / night-shift dispatchers are STATELESS - every run wakes up
 * remembering nothing about previous attempts on the same ticket. The Brain is
 * the per-ticket file that survives across dispatches so the NEXT shift picks
 * up what the LAST shift learned, instead of walking into the same wall.
 *
 * This file is the single source of truth for the record shape. `writer.mjs`,
 * `reader.mjs`, `summarize.mjs`, and every future wire-in read the JSDoc types
 * defined here. Bump the SCHEMA_VERSION when you change the shape - `reader.mjs`
 * uses it to know when to run a migration.
 *
 * MVP storage: one JSON file per ticket at $AGENT_BRAIN_ROOT/ticket-<n>.json.
 * Node builtins only (no npm deps). See `storage-json.mjs` for the I/O layer
 * and `docs/architecture/AGENT_BRAIN.md` for the full design + rationale.
 */

'use strict';

/** Bump on any breaking change to the on-disk record shape. */
export const SCHEMA_VERSION = 1;

/**
 * The verdict an autonomous shift reports for its own run on a ticket.
 * Kept small on purpose - reviewers use `Verdict` below to grade the PR.
 * @typedef {'COMPLETE'|'OUT-OF-SCOPE'|'STUCK'|'FAILED-CI'|'SUPERSEDED'|'MERGED'} AttemptOutcome
 */

/** Which autonomous shift picked the ticket up. @typedef {'day'|'night'} Shift */

/**
 * Human/review-skill verdict on a shift's PR.
 * @typedef {'CLEAN'|'MINOR'|'MAJOR'|'BLOCK'} VerdictGrade
 */

/**
 * One dispatch worth of history for a ticket. Recorded by the worker
 * (or by the dispatcher on its behalf) at the end of the run.
 *
 * @typedef {Object} Attempt
 * @property {string} id                  - stable id, e.g. `attempt-<iso>-<rand6>`
 * @property {string} dispatched_at       - ISO-8601 UTC (when the run started)
 * @property {Shift}  shift               - 'day' or 'night'
 * @property {string} worker_id           - identifier from the shift runtime
 * @property {string} branch              - dayshift/1234-slug or nightshift/1234-slug
 * @property {string|null} pr_url         - draft PR URL if one was opened
 * @property {AttemptOutcome} outcome     - final verdict of the worker
 * @property {number} duration_sec        - wall-clock duration of the run
 * @property {string=} error_summary      - one-line reason for OUT-OF-SCOPE/STUCK/FAILED
 * @property {string[]=} files_touched    - relative paths touched (best effort)
 * @property {string[]=} key_learnings    - short facts the worker discovered
 */

/**
 * A verdict recorded by /desk-review or /morning-review on an attempt's PR.
 *
 * @typedef {Object} Verdict
 * @property {string} id                  - stable id, e.g. `verdict-<iso>-<rand6>`
 * @property {string} recorded_at         - ISO-8601 UTC
 * @property {'desk-review'|'morning-review'|'human'|string} reviewer
 * @property {VerdictGrade} verdict
 * @property {string=} attempt_id         - back-ref to the Attempt reviewed
 * @property {string=} pr_url             - PR that was reviewed
 * @property {string=} notes              - reviewer notes (kept short in the brain)
 */

/**
 * A next-attempt hint - the ONLY field the NEXT shift is required to skim.
 * Hints are deduped by canonical text so the same hint added twice doesn't
 * accumulate. Sources: review skills, prior worker learnings promoted by a
 * reviewer, or a human hand-adding one.
 *
 * @typedef {Object} Hint
 * @property {string} id                  - stable id
 * @property {string} text                - the hint itself (<= 240 chars)
 * @property {string} added_at            - ISO-8601 UTC
 * @property {'desk-review'|'morning-review'|'human'|'worker'|string} source
 */

/**
 * If a ticket keeps bouncing (e.g. 3 OUT-OF-SCOPE verdicts), the dispatcher
 * should stop auto-picking it and escalate to a human. This block is the
 * durable flag it checks BEFORE selecting the ticket.
 *
 * @typedef {Object} EscalationState
 * @property {boolean} auto_escalate      - true = dispatcher should skip
 * @property {string|null} reason         - one-line why
 * @property {string|null} escalated_at   - ISO-8601 UTC
 */

/**
 * The full Brain record for one GitHub issue.
 *
 * @typedef {Object} BrainRecord
 * @property {number} schema_version      - see SCHEMA_VERSION above
 * @property {number} ticket_id           - the GitHub issue number
 * @property {string} created_at          - ISO-8601 UTC (record created)
 * @property {string} updated_at          - ISO-8601 UTC (last write)
 * @property {Attempt[]} attempts         - chronological (oldest first)
 * @property {Verdict[]} verdicts         - chronological (oldest first)
 * @property {Hint[]} hints               - dedup'd by canonicalText(hint.text)
 * @property {EscalationState} escalation
 */

/**
 * Build a fresh empty record for a ticket. Callers (storage layer) hydrate
 * this on first-touch when no file exists on disk yet.
 *
 * @param {number} ticketId
 * @param {string=} nowIso                - injectable for deterministic tests
 * @returns {BrainRecord}
 */
export function emptyRecord(ticketId, nowIso) {
  const now = nowIso || new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    ticket_id: Number(ticketId),
    created_at: now,
    updated_at: now,
    attempts: [],
    verdicts: [],
    hints: [],
    escalation: { auto_escalate: false, reason: null, escalated_at: null },
  };
}

/**
 * Canonicalise a hint's text so semantically-equivalent hints dedup. We
 * lowercase, collapse whitespace, and strip trailing punctuation so
 * "Migration broke RLS." and "migration  broke rls" hash the same.
 *
 * @param {string} text
 * @returns {string}
 */
export function canonicalHintText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?\s]+$/g, '')
    .trim();
}
