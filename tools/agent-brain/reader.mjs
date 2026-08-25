/**
 * reader.mjs - read-only query helpers over BrainRecord.
 *
 * Kept separate from writer.mjs so the dispatcher can pull in ONLY read paths
 * (no accidental mutation from a "just checking" call). All functions are
 * pure over their record argument - I/O is delegated to `storage-json`.
 */

'use strict';

import { readRecord } from './storage-json.mjs';
import { emptyRecord } from './schema.mjs';

/**
 * Load a record; return an empty (unwritten) record if the file doesn't exist.
 * Callers use this + query helpers below to decide re-dispatch behaviour.
 *
 * @param {string} root
 * @param {number|string} ticketId
 * @returns {Promise<import('./schema.mjs').BrainRecord>}
 */
export async function loadRecord(root, ticketId) {
  const existing = await readRecord(root, ticketId);
  return existing || emptyRecord(ticketId);
}

/**
 * Is the ticket auto-escalated? Dispatcher checks this BEFORE selecting.
 * @param {import('./schema.mjs').BrainRecord} record
 * @returns {boolean}
 */
export function isAutoEscalated(record) {
  return Boolean(record && record.escalation && record.escalation.auto_escalate === true);
}

/**
 * Escalation reason (or null if not escalated).
 * @param {import('./schema.mjs').BrainRecord} record
 * @returns {string|null}
 */
export function escalationReason(record) {
  if (!isAutoEscalated(record)) return null;
  return record.escalation.reason || null;
}

/**
 * Attempts count - useful for "give up after N" gating.
 * @param {import('./schema.mjs').BrainRecord} record
 * @returns {number}
 */
export function getAttemptCount(record) {
  return Array.isArray(record?.attempts) ? record.attempts.length : 0;
}

/**
 * Most recent attempt, or null if no attempts recorded yet.
 * @param {import('./schema.mjs').BrainRecord} record
 * @returns {import('./schema.mjs').Attempt|null}
 */
export function getLastAttempt(record) {
  const attempts = record?.attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  return attempts[attempts.length - 1];
}

/**
 * All active hints, chronological (oldest first). Callers typically dedupe
 * upstream via `writer.addHint`, so this returns whatever is stored.
 *
 * @param {import('./schema.mjs').BrainRecord} record
 * @returns {import('./schema.mjs').Hint[]}
 */
export function getActiveHints(record) {
  return Array.isArray(record?.hints) ? record.hints.slice() : [];
}

/**
 * Flat, deduped list of key learnings across all attempts. Order preserved
 * from oldest attempt to newest. Duplicates (identical strings) collapse.
 *
 * @param {import('./schema.mjs').BrainRecord} record
 * @returns {string[]}
 */
export function getAllKeyLearnings(record) {
  const seen = new Set();
  const out = [];
  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  for (const a of attempts) {
    if (!Array.isArray(a?.key_learnings)) continue;
    for (const l of a.key_learnings) {
      const t = String(l || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * How many recent attempts landed with this outcome? Useful for
 * "escalate-after-N-consecutive-STUCK" style gates.
 *
 * @param {import('./schema.mjs').BrainRecord} record
 * @param {import('./schema.mjs').AttemptOutcome} outcome
 * @param {number} [lookback=Infinity]  - only count within the last N attempts
 * @returns {number}
 */
export function countRecentOutcome(record, outcome, lookback = Infinity) {
  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  const slice = lookback === Infinity ? attempts : attempts.slice(-lookback);
  return slice.filter((a) => a.outcome === outcome).length;
}
