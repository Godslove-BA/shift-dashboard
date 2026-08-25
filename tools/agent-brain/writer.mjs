/**
 * writer.mjs - mutation API for the Agent Brain.
 *
 * Every mutation is a read-mutate-write cycle: load-or-init the record,
 * mutate the JS object, write it back atomically via `storage-json.writeRecord`.
 * No in-memory cache - correctness across concurrent dispatchers matters more
 * than per-call latency (brain writes happen once per run, not in a hot loop).
 *
 * Callers pass a `nowFn` for deterministic tests; production defaults to
 * `new Date().toISOString()`.
 */

'use strict';

import { randomBytes } from 'node:crypto';
import { canonicalHintText } from './schema.mjs';
import { loadOrInit, writeRecord } from './storage-json.mjs';

function nowIso(nowFn) {
  return nowFn ? nowFn() : new Date().toISOString();
}

function makeId(prefix, nowFn) {
  return `${prefix}-${nowIso(nowFn)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Record one dispatch attempt at the end of a worker run.
 * The worker knows: outcome, duration, files touched, key learnings, PR url.
 * The dispatcher knows: which shift, which worker_id, which branch.
 * This helper is called by whichever side has all the data (typically the
 * dispatcher, using the worker's exit output).
 *
 * @param {string} root
 * @param {number|string} ticketId
 * @param {Object} data
 * @param {'day'|'night'} data.shift
 * @param {string} data.worker_id
 * @param {string} data.branch
 * @param {string|null} [data.pr_url]
 * @param {import('./schema.mjs').AttemptOutcome} data.outcome
 * @param {number} data.duration_sec
 * @param {string=} data.error_summary
 * @param {string[]=} data.files_touched
 * @param {string[]=} data.key_learnings
 * @param {() => string=} nowFn
 * @returns {Promise<import('./schema.mjs').BrainRecord>}
 */
export async function recordAttempt(root, ticketId, data, nowFn) {
  if (!data || !data.shift || !data.outcome) {
    throw new Error('recordAttempt: shift + outcome are required');
  }
  const record = await loadOrInit(root, ticketId, nowFn);
  const attempt = {
    id: makeId('attempt', nowFn),
    dispatched_at: nowIso(nowFn),
    shift: data.shift,
    worker_id: String(data.worker_id || ''),
    branch: String(data.branch || ''),
    pr_url: data.pr_url || null,
    outcome: data.outcome,
    duration_sec: Number(data.duration_sec) || 0,
  };
  if (data.error_summary) attempt.error_summary = String(data.error_summary);
  if (Array.isArray(data.files_touched)) attempt.files_touched = data.files_touched.slice();
  if (Array.isArray(data.key_learnings)) attempt.key_learnings = data.key_learnings.slice();
  record.attempts.push(attempt);
  record.updated_at = nowIso(nowFn);
  await writeRecord(root, record);
  return record;
}

/**
 * Record a verdict from a reviewer (desk-review / morning-review / human).
 *
 * @param {string} root
 * @param {number|string} ticketId
 * @param {Object} data
 * @param {string} data.reviewer
 * @param {import('./schema.mjs').VerdictGrade} data.verdict
 * @param {string=} data.attempt_id
 * @param {string=} data.pr_url
 * @param {string=} data.notes
 * @param {() => string=} nowFn
 * @returns {Promise<import('./schema.mjs').BrainRecord>}
 */
export async function recordVerdict(root, ticketId, data, nowFn) {
  if (!data || !data.reviewer || !data.verdict) {
    throw new Error('recordVerdict: reviewer + verdict are required');
  }
  const record = await loadOrInit(root, ticketId, nowFn);
  const verdict = {
    id: makeId('verdict', nowFn),
    recorded_at: nowIso(nowFn),
    reviewer: data.reviewer,
    verdict: data.verdict,
  };
  if (data.attempt_id) verdict.attempt_id = data.attempt_id;
  if (data.pr_url) verdict.pr_url = data.pr_url;
  if (data.notes) verdict.notes = data.notes;
  record.verdicts.push(verdict);
  record.updated_at = nowIso(nowFn);
  await writeRecord(root, record);
  return record;
}

/**
 * Add a next-attempt hint, deduped by canonical text so re-runs don't
 * accumulate near-duplicates. Returns { added: boolean, hint | null }.
 *
 * @param {string} root
 * @param {number|string} ticketId
 * @param {string} text
 * @param {'desk-review'|'morning-review'|'human'|'worker'|string} source
 * @param {() => string=} nowFn
 * @returns {Promise<{ added: boolean, hint: import('./schema.mjs').Hint | null, record: import('./schema.mjs').BrainRecord }>}
 */
export async function addHint(root, ticketId, text, source, nowFn) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('addHint: text is required');
  if (trimmed.length > 240) throw new Error('addHint: text must be <= 240 chars');
  if (!source) throw new Error('addHint: source is required');

  const record = await loadOrInit(root, ticketId, nowFn);
  const canonical = canonicalHintText(trimmed);
  const existing = record.hints.find((h) => canonicalHintText(h.text) === canonical);
  if (existing) return { added: false, hint: null, record };

  const hint = {
    id: makeId('hint', nowFn),
    text: trimmed,
    added_at: nowIso(nowFn),
    source: String(source),
  };
  record.hints.push(hint);
  record.updated_at = nowIso(nowFn);
  await writeRecord(root, record);
  return { added: true, hint, record };
}

/**
 * Escalate a ticket: dispatcher must stop auto-picking it and hand off to
 * a human. Idempotent - re-escalating with a new reason overwrites the
 * previous reason but keeps the original `escalated_at`.
 *
 * @param {string} root
 * @param {number|string} ticketId
 * @param {string} reason
 * @param {() => string=} nowFn
 */
export async function escalate(root, ticketId, reason, nowFn) {
  const record = await loadOrInit(root, ticketId, nowFn);
  const already = record.escalation && record.escalation.auto_escalate;
  record.escalation = {
    auto_escalate: true,
    reason: String(reason || 'no reason given'),
    escalated_at: already ? record.escalation.escalated_at : nowIso(nowFn),
  };
  record.updated_at = nowIso(nowFn);
  await writeRecord(root, record);
  return record;
}

/**
 * Un-escalate. Used by desk-review or a human clearing a stale escalation.
 * @param {string} root
 * @param {number|string} ticketId
 * @param {() => string=} nowFn
 */
export async function clearEscalation(root, ticketId, nowFn) {
  const record = await loadOrInit(root, ticketId, nowFn);
  record.escalation = { auto_escalate: false, reason: null, escalated_at: null };
  record.updated_at = nowIso(nowFn);
  await writeRecord(root, record);
  return record;
}
