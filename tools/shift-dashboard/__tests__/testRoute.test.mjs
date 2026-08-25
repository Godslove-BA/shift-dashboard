// Tests for the shift-dashboard "Test in browser" affordance.
// - parseTestRoute: extracts the day-shift-emitted <!-- test-route:v1 {...} -->
//   marker with strict field whitelisting.
// - renderTestBrowserLink: renders the clickable link with the exact
//   localhost URL, plus optional open-hint and prerequisite line.
//   Empty string when no marker present (dashboard hides affordance).
//
// Run: node --test tools/shift-dashboard/__tests__/testRoute.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestRoute, renderTestBrowserLink } from '../worker.js';

test('parseTestRoute: null / empty body → null', () => {
  assert.equal(parseTestRoute(null), null);
  assert.equal(parseTestRoute(''), null);
  assert.equal(parseTestRoute('PR body with no marker'), null);
});

test('parseTestRoute: minimal marker (path only) defaults port to 8080', () => {
  const body = 'body\n<!-- test-route:v1 {"path":"/business/analytics"} -->';
  assert.deepEqual(parseTestRoute(body), {
    schemaVersion: 1,
    path: '/business/analytics',
    port: 8080,
  });
});

test('parseTestRoute: full marker round-trips', () => {
  const body = `<!-- test-route:v1 {"path":"/business/edit-image","port":3000,"open":"Click 'Animate flyer'","hint":"Requires existing flyer"} -->`;
  assert.deepEqual(parseTestRoute(body), {
    schemaVersion: 1,
    path: '/business/edit-image',
    port: 3000,
    open: "Click 'Animate flyer'",
    hint: 'Requires existing flyer',
  });
});

test('parseTestRoute: path MUST start with slash', () => {
  const body = '<!-- test-route:v1 {"path":"business/x"} -->';
  assert.equal(parseTestRoute(body), null);
});

test('parseTestRoute: malformed JSON → null (does not throw)', () => {
  const body = '<!-- test-route:v1 {not json} -->';
  assert.equal(parseTestRoute(body), null);
});

test('parseTestRoute: field whitelist drops arbitrary keys', () => {
  const body = '<!-- test-route:v1 {"path":"/x","onclick":"alert(1)","evil":"payload"} -->';
  const r = parseTestRoute(body);
  assert.equal('onclick' in r, false);
  assert.equal('evil' in r, false);
});

test('parseTestRoute: port out of range falls back to default 8080', () => {
  const body = '<!-- test-route:v1 {"path":"/x","port":99999} -->';
  assert.equal(parseTestRoute(body).port, 8080);
});

test('parseTestRoute: coexists with agent-brain marker in same body', () => {
  const body = `PR body
<!-- agent-brain:v1 {"ticketId":1266,"attempts":1} -->
<!-- test-route:v1 {"path":"/business/x"} -->`;
  const r = parseTestRoute(body);
  assert.equal(r.path, '/business/x');
});

test('parseTestRoute: schemaVersion extracted from marker', () => {
  const body = '<!-- test-route:v2 {"path":"/x"} -->';
  assert.equal(parseTestRoute(body).schemaVersion, 2);
});

test('renderTestBrowserLink: null → empty string (hides affordance)', () => {
  assert.equal(renderTestBrowserLink(null), '');
  assert.equal(renderTestBrowserLink(undefined), '');
});

test('renderTestBrowserLink: renders clickable link with correct URL', () => {
  const html = renderTestBrowserLink({ path: '/business/analytics', port: 8080 });
  assert.ok(html.includes('href="http://localhost:8080/business/analytics"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('Test in browser'));
});

test('renderTestBrowserLink: uses non-default port when specified', () => {
  const html = renderTestBrowserLink({ path: '/x', port: 3000 });
  assert.ok(html.includes('http://localhost:3000/x'));
  assert.ok(!html.includes('8080'));
});

test('renderTestBrowserLink: shows open-hint inline when present', () => {
  const html = renderTestBrowserLink({ path: '/x', port: 8080, open: "Click 'Animate flyer'" });
  assert.ok(html.includes("Click &#39;Animate flyer&#39;") || html.includes("Click 'Animate flyer'"));
});

test('renderTestBrowserLink: shows prerequisite hint on its own line when present', () => {
  const html = renderTestBrowserLink({ path: '/x', port: 8080, hint: 'Log in first' });
  assert.ok(html.includes('tb-prereq'));
  assert.ok(html.includes('Log in first'));
});

test('renderTestBrowserLink: escapes HTML in hint fields (defence in depth)', () => {
  const html = renderTestBrowserLink({
    path: '/x',
    port: 8080,
    open: '<script>alert(1)</script>',
    hint: '<img src=x onerror=alert(2)>',
  });
  // The raw tags must not appear as tags. The literal string "onerror=" can
  // still appear in the ESCAPED text, which is safe (it's text content, not
  // an attribute) - so we don't assert against the substring.
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
});
