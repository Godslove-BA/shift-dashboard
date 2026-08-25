// Unit tests for tools/agent-brain/storage-json.mjs.
//
// Uses a per-test tmp directory (fs.mkdtemp) so tests don't touch the real
// ~/.agent-brain root. Focus areas:
// - resolveBrainRoot precedence (explicit > env > default)
// - read/write roundtrip preserves the exact record
// - atomic write leaves no stray `.tmp-*` files
// - corrupt files get renamed aside + null returned (dispatcher must NOT crash)
//
// Run: node --test tools/agent-brain/__tests__/storage-json.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveBrainRoot,
  ensureBrainRoot,
  pathForTicket,
  readRecord,
  writeRecord,
  loadOrInit,
} from '../storage-json.mjs';
import { emptyRecord } from '../schema.mjs';

async function makeTmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agent-brain-test-'));
}

test('resolveBrainRoot: explicit arg wins', () => {
  const prev = process.env.AGENT_BRAIN_ROOT;
  process.env.AGENT_BRAIN_ROOT = '/from/env';
  try {
    assert.equal(resolveBrainRoot('/from/arg'), '/from/arg');
  } finally {
    if (prev === undefined) delete process.env.AGENT_BRAIN_ROOT;
    else process.env.AGENT_BRAIN_ROOT = prev;
  }
});

test('resolveBrainRoot: env wins over default when no arg', () => {
  const prev = process.env.AGENT_BRAIN_ROOT;
  process.env.AGENT_BRAIN_ROOT = '/from/env';
  try {
    assert.equal(resolveBrainRoot(), '/from/env');
  } finally {
    if (prev === undefined) delete process.env.AGENT_BRAIN_ROOT;
    else process.env.AGENT_BRAIN_ROOT = prev;
  }
});

test('resolveBrainRoot: falls back to ~/.agent-brain/<project>', () => {
  const prevRoot = process.env.AGENT_BRAIN_ROOT;
  const prevProj = process.env.AGENT_BRAIN_PROJECT;
  delete process.env.AGENT_BRAIN_ROOT;
  process.env.AGENT_BRAIN_PROJECT = 'myproj';
  try {
    assert.equal(resolveBrainRoot(), path.join(os.homedir(), '.agent-brain', 'myproj'));
  } finally {
    if (prevRoot !== undefined) process.env.AGENT_BRAIN_ROOT = prevRoot;
    if (prevProj === undefined) delete process.env.AGENT_BRAIN_PROJECT;
    else process.env.AGENT_BRAIN_PROJECT = prevProj;
  }
});

test('pathForTicket: builds ticket-<n>.json under root', () => {
  assert.equal(pathForTicket('/r', 7), '/r/ticket-7.json');
  assert.equal(pathForTicket('/r', '7'), '/r/ticket-7.json');
});

test('pathForTicket: rejects non-positive-int ticketIds', () => {
  assert.throws(() => pathForTicket('/r', 0));
  assert.throws(() => pathForTicket('/r', -1));
  assert.throws(() => pathForTicket('/r', 1.5));
  assert.throws(() => pathForTicket('/r', 'abc'));
});

test('read/write roundtrip preserves the exact record', async () => {
  const root = await makeTmpRoot();
  await ensureBrainRoot(root);
  const original = emptyRecord(123, '2026-07-29T12:00:00.000Z');
  original.hints.push({
    id: 'hint-x',
    text: 'hello',
    added_at: '2026-07-29T12:00:00.000Z',
    source: 'human',
  });
  await writeRecord(root, original);
  const loaded = await readRecord(root, 123);
  assert.deepEqual(loaded, original);
});

test('readRecord returns null for a missing ticket', async () => {
  const root = await makeTmpRoot();
  const loaded = await readRecord(root, 999);
  assert.equal(loaded, null);
});

test('writeRecord leaves no stray .tmp files after success', async () => {
  const root = await makeTmpRoot();
  await writeRecord(root, emptyRecord(1, '2026-07-29T00:00:00.000Z'));
  await writeRecord(root, emptyRecord(1, '2026-07-29T00:00:01.000Z'));
  await writeRecord(root, emptyRecord(2, '2026-07-29T00:00:02.000Z'));
  const entries = await fs.readdir(root);
  const stray = entries.filter((e) => e.includes('.tmp-'));
  assert.deepEqual(stray, []);
});

test('writeRecord rejects records without ticket_id', async () => {
  const root = await makeTmpRoot();
  await assert.rejects(() => writeRecord(root, {}));
  await assert.rejects(() => writeRecord(root, { ticket_id: 'nope' }));
});

test('readRecord renames corrupt files aside + returns null', async () => {
  const root = await makeTmpRoot();
  const p = pathForTicket(root, 42);
  await ensureBrainRoot(root);
  await fs.writeFile(p, '{not valid json', 'utf8');
  const result = await readRecord(root, 42);
  assert.equal(result, null);
  // Original file is gone; a `.corrupt-*` sibling exists.
  const entries = await fs.readdir(root);
  assert.equal(entries.some((e) => e.startsWith('ticket-42.json.corrupt-')), true);
  assert.equal(entries.includes('ticket-42.json'), false);
});

test('loadOrInit returns existing record if present', async () => {
  const root = await makeTmpRoot();
  const original = emptyRecord(5, '2026-07-29T00:00:00.000Z');
  await writeRecord(root, original);
  const loaded = await loadOrInit(root, 5);
  assert.deepEqual(loaded, original);
});

test('loadOrInit returns a fresh empty record if none exists (no write)', async () => {
  const root = await makeTmpRoot();
  const fresh = await loadOrInit(root, 6, () => '2026-07-29T00:00:00.000Z');
  assert.equal(fresh.ticket_id, 6);
  assert.equal(fresh.attempts.length, 0);
  // Confirm it wasn't persisted (fresh scaffolding only writes when a mutation follows).
  const entries = await fs.readdir(root).catch(() => []);
  assert.deepEqual(entries.filter((e) => e === 'ticket-6.json'), []);
});
