/**
 * storage-json.mjs - filesystem I/O for the Agent Brain.
 *
 * One JSON file per ticket at `$AGENT_BRAIN_ROOT/ticket-<n>.json`.
 * Writes are atomic (tmp + rename) so a crash mid-write can't leave a
 * corrupted file that breaks the next dispatch.
 *
 * Pure Node builtins - no npm deps. See `schema.js` for the record shape.
 */

'use strict';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import { SCHEMA_VERSION, emptyRecord } from './schema.mjs';

/**
 * Resolve the root directory brain records live in.
 * Priority: explicit arg > $AGENT_BRAIN_ROOT env > `~/.agent-brain/<project>`
 * `project` defaults to $AGENT_BRAIN_PROJECT or 'the-source-project'.
 *
 * @param {string=} explicitRoot
 * @returns {string}
 */
export function resolveBrainRoot(explicitRoot) {
  if (explicitRoot) return explicitRoot;
  if (process.env.AGENT_BRAIN_ROOT) return process.env.AGENT_BRAIN_ROOT;
  const project = process.env.AGENT_BRAIN_PROJECT || 'the-source-project';
  return path.join(os.homedir(), '.agent-brain', project);
}

/**
 * Make sure the brain root exists. Safe to call repeatedly.
 * @param {string} root
 */
export async function ensureBrainRoot(root) {
  await fs.mkdir(root, { recursive: true });
}

/**
 * Absolute path for a ticket's record file.
 * @param {string} root
 * @param {number|string} ticketId
 * @returns {string}
 */
export function pathForTicket(root, ticketId) {
  const n = Number(ticketId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`storage-json: ticketId must be a positive integer, got ${ticketId}`);
  }
  return path.join(root, `ticket-${n}.json`);
}

/**
 * Load a ticket's brain record. Returns null if the file doesn't exist yet.
 * A file that exists but fails to parse is treated as corrupt: we rename it
 * aside (`.corrupt-<iso>`) and return null so the caller starts fresh -
 * losing history is bad, but blocking every future dispatch is worse.
 *
 * @param {string} root
 * @param {number|string} ticketId
 * @returns {Promise<import('./schema.mjs').BrainRecord|null>}
 */
export async function readRecord(root, ticketId) {
  const p = pathForTicket(root, ticketId);
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    // Minimal shape guard - callers can assume the top-level structure.
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.ticket_id)) {
      throw new Error('parsed record failed shape check');
    }
    return parsed;
  } catch (err) {
    const corrupt = `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.rename(p, corrupt).catch(() => {});
    // Intentional: log to stderr; the dispatcher captures this to day-shift.err.log.
    console.warn(`[agent-brain] corrupt record for ticket ${ticketId} moved aside → ${corrupt}: ${err.message}`);
    return null;
  }
}

/**
 * Atomically write a brain record to disk.
 * Strategy: write to a sibling tmp file, then `rename` (atomic on POSIX).
 * If the write is interrupted, the original file is untouched.
 *
 * @param {string} root
 * @param {import('./schema.mjs').BrainRecord} record
 */
export async function writeRecord(root, record) {
  if (!record || typeof record !== 'object') {
    throw new Error('storage-json.writeRecord: record must be an object');
  }
  if (!Number.isInteger(record.ticket_id)) {
    throw new Error('storage-json.writeRecord: record.ticket_id must be an integer');
  }
  await ensureBrainRoot(root);
  const dest = pathForTicket(root, record.ticket_id);
  const tmp = `${dest}.tmp-${randomBytes(6).toString('hex')}`;
  const body = JSON.stringify(record, null, 2) + '\n';
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, dest);
}

/**
 * Load a ticket's record OR return a fresh empty one. Used by writers who
 * need "read-or-create" semantics without repeating the null-check.
 *
 * @param {string} root
 * @param {number|string} ticketId
 * @param {(iso?: string) => string=} nowFn  - injectable for deterministic tests
 * @returns {Promise<import('./schema.mjs').BrainRecord>}
 */
export async function loadOrInit(root, ticketId, nowFn) {
  const existing = await readRecord(root, ticketId);
  if (existing) return existing;
  const nowIso = nowFn ? nowFn() : new Date().toISOString();
  return emptyRecord(ticketId, nowIso);
}

export { SCHEMA_VERSION };
