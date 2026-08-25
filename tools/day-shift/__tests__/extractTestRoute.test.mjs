// Tests for worker.mjs `extractTestRoute` - parses the TEST_ROUTE marker
// the worker emits in progress.txt when the change is browser-testable.
//
// Contract (see prompts/worker-system.md):
//   TEST_ROUTE: {"path":"/business/...","port":8080,"open":"...","hint":"..."}
//
// Field whitelist enforced; malformed JSON returns null; missing marker
// returns null (change was not declared browser-testable).
//
// Run: node --test tools/day-shift/__tests__/extractTestRoute.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTestRoute } from '../worker.mjs';

test('null / empty progress → null (worker did not emit marker)', () => {
  assert.equal(extractTestRoute(null), null);
  assert.equal(extractTestRoute(''), null);
  assert.equal(extractTestRoute('Iteration 1 - ...\nCOMPLETE - done\n'), null);
});

test('minimal valid marker: path only', () => {
  const notes = `COMPLETE - done
TEST_ROUTE: {"path":"/business/analytics"}
<promise>COMPLETE</promise>`;
  assert.deepEqual(extractTestRoute(notes), { path: '/business/analytics' });
});

test('full marker: path + port + open + hint', () => {
  const notes = `TEST_ROUTE: {"path":"/business/edit-image","port":8080,"open":"Click 'Animate flyer'","hint":"Requires an existing flyer"}`;
  assert.deepEqual(extractTestRoute(notes), {
    path: '/business/edit-image',
    port: 8080,
    open: "Click 'Animate flyer'",
    hint: 'Requires an existing flyer',
  });
});

test('path MUST start with /', () => {
  assert.equal(extractTestRoute('TEST_ROUTE: {"path":"business/no-slash"}'), null);
});

test('path MUST be a string', () => {
  assert.equal(extractTestRoute('TEST_ROUTE: {"path":123}'), null);
});

test('malformed JSON → null (does not throw)', () => {
  assert.equal(extractTestRoute('TEST_ROUTE: {not valid json}'), null);
});

test('port out of range → dropped', () => {
  const r = extractTestRoute('TEST_ROUTE: {"path":"/x","port":99999}');
  assert.equal(r.path, '/x');
  assert.equal('port' in r, false);
});

test('port as string → dropped (Number.isFinite gate)', () => {
  const r = extractTestRoute('TEST_ROUTE: {"path":"/x","port":"8080"}');
  assert.equal('port' in r, false);
});

test('open + hint truncated to 240 chars', () => {
  const long = 'a'.repeat(500);
  const r = extractTestRoute(`TEST_ROUTE: {"path":"/x","open":"${long}","hint":"${long}"}`);
  assert.equal(r.open.length, 240);
  assert.equal(r.hint.length, 240);
});

test('path truncated to 200 chars', () => {
  const longPath = '/' + 'a'.repeat(500);
  const r = extractTestRoute(`TEST_ROUTE: {"path":"${longPath}"}`);
  assert.equal(r.path.length, 200);
});

test('field whitelist: extra keys dropped', () => {
  const r = extractTestRoute('TEST_ROUTE: {"path":"/x","malicious":"<script>","other":42}');
  assert.equal('malicious' in r, false);
  assert.equal('other' in r, false);
});

test('empty open / hint strings ignored (require non-blank content)', () => {
  const r = extractTestRoute('TEST_ROUTE: {"path":"/x","open":"   ","hint":""}');
  assert.equal('open' in r, false);
  assert.equal('hint' in r, false);
});

test('marker at any line in progress.txt (not just the last)', () => {
  const notes = `Iteration 1 - reasoning
TEST_ROUTE: {"path":"/business/x","port":8080}
Iteration 2 - more work
COMPLETE - done
<promise>COMPLETE</promise>`;
  const r = extractTestRoute(notes);
  assert.equal(r.path, '/business/x');
  assert.equal(r.port, 8080);
});
