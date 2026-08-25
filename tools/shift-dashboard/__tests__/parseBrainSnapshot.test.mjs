// Unit tests for shift-dashboard/worker.js `parseBrainSnapshot`.
//
// The parser reads the HTML comment day-shift embeds in PR bodies. Tests pin:
// - Malformed / missing → null (dashboard shows nothing, doesn't crash)
// - Field whitelist (a malicious PR body cannot inject arbitrary keys)
// - Number coercion + escalated boolean strictness
//
// Run: node --test tools/shift-dashboard/__tests__/parseBrainSnapshot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrainSnapshot, fmtDur } from '../worker.js';

test('null / empty body → null', () => {
  assert.equal(parseBrainSnapshot(null), null);
  assert.equal(parseBrainSnapshot(''), null);
  assert.equal(parseBrainSnapshot('body with no brain block'), null);
});

test('valid snapshot round-trips', () => {
  const body = `some PR body\n\n<!-- agent-brain:v1 {"ticketId":1234,"attempts":3,"lastOutcome":"STUCK","lastDurationSec":1500,"hints":2,"escalated":false,"updatedAt":"2026-07-29T00:00:00Z"} -->\n`;
  const parsed = parseBrainSnapshot(body);
  assert.deepEqual(parsed, {
    schemaVersion: 1,
    ticketId: 1234,
    attempts: 3,
    lastOutcome: 'STUCK',
    lastDurationSec: 1500,
    hints: 2,
    escalated: false,
    updatedAt: '2026-07-29T00:00:00Z',
  });
});

test('extracts schemaVersion from the comment marker', () => {
  const body = `<!-- agent-brain:v2 {"ticketId":1} -->`;
  const parsed = parseBrainSnapshot(body);
  assert.equal(parsed.schemaVersion, 2);
});

test('malformed JSON → null (not a throw)', () => {
  const body = `<!-- agent-brain:v1 {not valid json} -->`;
  assert.equal(parseBrainSnapshot(body), null);
});

test('missing ticketId → null', () => {
  const body = `<!-- agent-brain:v1 {"attempts":1} -->`;
  assert.equal(parseBrainSnapshot(body), null);
});

test('ticketId as string → null (strict number check)', () => {
  const body = `<!-- agent-brain:v1 {"ticketId":"abc"} -->`;
  assert.equal(parseBrainSnapshot(body), null);
});

test('field whitelist: extra keys in the JSON are dropped', () => {
  const body = `<!-- agent-brain:v1 {"ticketId":1,"malicious":"<script>","other":123} -->`;
  const parsed = parseBrainSnapshot(body);
  assert.equal('malicious' in parsed, false);
  assert.equal('other' in parsed, false);
});

test('escalated is strictly === true (any other value → false)', () => {
  // Loop values are all valid JSON. undefined isn't - JSON.stringify(undefined) = undefined,
  // which would produce invalid JSON and return null before we can check escalated.
  for (const val of ['true', 1, {}, 'yes', null, false, 0]) {
    const body = `<!-- agent-brain:v1 {"ticketId":1,"escalated":${JSON.stringify(val)}} -->`;
    assert.equal(parseBrainSnapshot(body).escalated, false, `escalated should be false for ${JSON.stringify(val)}`);
  }
  const okBody = `<!-- agent-brain:v1 {"ticketId":1,"escalated":true} -->`;
  assert.equal(parseBrainSnapshot(okBody).escalated, true);
});

test('picks the first snapshot when multiple present (defensive)', () => {
  const body = `<!-- agent-brain:v1 {"ticketId":1} -->\nsome text\n<!-- agent-brain:v1 {"ticketId":2} -->`;
  assert.equal(parseBrainSnapshot(body).ticketId, 1);
});

test('tolerates whitespace variance around the comment', () => {
  const body = `<!--   agent-brain:v1  {"ticketId":99}    -->`;
  assert.equal(parseBrainSnapshot(body).ticketId, 99);
});

test('fmtDur: humanizes seconds', () => {
  assert.equal(fmtDur(0), '0s');
  assert.equal(fmtDur(45), '45s');
  assert.equal(fmtDur(60), '1m');
  assert.equal(fmtDur(65), '1m5s');
  assert.equal(fmtDur(1500), '25m');
  assert.equal(fmtDur(3665), '61m5s');
});
