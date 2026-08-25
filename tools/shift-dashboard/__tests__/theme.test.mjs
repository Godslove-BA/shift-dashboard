// Tests for the theme toggle (v6): server-side URL-param + cookie
// resolution, and the rendered pill-group that preserves other query
// params on click.
//
// Server-side is the only CSP-safe option today (default-src 'none' blocks
// inline JS). Reload cost is acceptable given the dashboard's own 30s
// auto-refresh.
//
// Run: node --test tools/shift-dashboard/__tests__/theme.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, renderThemeToggle } from '../worker.js';

// ─── resolveTheme ────────────────────────────────────────────────────

test('resolveTheme: default is "auto" when no query + no cookie', () => {
  assert.equal(resolveTheme(new URL('https://x.example/'), ''), 'auto');
});

test('resolveTheme: ?theme=light wins over anything', () => {
  assert.equal(resolveTheme(new URL('https://x.example/?theme=light'), 'theme=dark'), 'light');
});

test('resolveTheme: ?theme=dark wins over cookie', () => {
  assert.equal(resolveTheme(new URL('https://x.example/?theme=dark'), 'theme=light'), 'dark');
});

test('resolveTheme: ?theme=auto explicitly returns auto (used to clear cookie)', () => {
  assert.equal(resolveTheme(new URL('https://x.example/?theme=auto'), 'theme=dark'), 'auto');
});

test('resolveTheme: cookie honored when no query param', () => {
  assert.equal(resolveTheme(new URL('https://x.example/'), 'theme=light'), 'light');
  assert.equal(resolveTheme(new URL('https://x.example/'), 'theme=dark'), 'dark');
});

test('resolveTheme: cookie parses correctly with other cookies present', () => {
  assert.equal(resolveTheme(new URL('https://x.example/'), 'session=abc; theme=dark; other=xyz'), 'dark');
});

test('resolveTheme: unknown values fall to auto (never trusts input)', () => {
  assert.equal(resolveTheme(new URL('https://x.example/?theme=xss'), ''), 'auto');
  assert.equal(resolveTheme(new URL('https://x.example/'), 'theme=xxx'), 'auto');
  assert.equal(resolveTheme(new URL('https://x.example/'), 'theme=<script>'), 'auto');
});

// ─── renderThemeToggle ───────────────────────────────────────────────

test('renderThemeToggle: renders 3 links (light / dark / auto)', () => {
  const html = renderThemeToggle('auto', null);
  assert.ok(html.includes('href="?theme=light"'));
  assert.ok(html.includes('href="?theme=dark"'));
  assert.ok(html.includes('href="?theme=auto"'));
});

test('renderThemeToggle: current theme gets the active class', () => {
  const dark = renderThemeToggle('dark', null);
  assert.ok(dark.match(/theme-toggle-active[^>]*>D/));
  assert.ok(!dark.match(/theme-toggle-active[^>]*>L/));
});

test('renderThemeToggle: preserves ?key= (and other query params) on click', () => {
  const url = new URL('https://x.example/?key=SECRET123&theme=auto');
  const html = renderThemeToggle('auto', url);
  // Every link must carry the key through so clicking doesn't 404.
  assert.ok(html.includes('key=SECRET123'), 'preserves key=');
  // The theme param should be REPLACED not accumulated.
  assert.ok(html.match(/theme=light/));
  assert.ok(html.match(/theme=dark/));
  assert.ok(html.match(/theme=auto/));
  // No literal string 'theme=light&theme=dark' etc.
  assert.ok(!html.includes('theme=light&theme=dark'));
});

test('renderThemeToggle: uses relative href (path+search), not absolute URL', () => {
  const url = new URL('https://x.example/dashboard?key=xyz');
  const html = renderThemeToggle('light', url);
  assert.ok(!html.includes('https://x.example'), 'href should be path-relative');
  assert.ok(html.includes('/dashboard?'));
});

test('renderThemeToggle: no inline JS (CSP compliance)', () => {
  const html = renderThemeToggle('dark', new URL('https://x.example/'));
  assert.ok(!html.includes('onclick'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('javascript:'));
});

test('renderThemeToggle: has aria-label for accessibility', () => {
  const html = renderThemeToggle('auto', null);
  assert.ok(html.includes('aria-label'));
  assert.ok(html.includes('role="group"'));
});
