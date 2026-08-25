/**
 * Theme resolution + toggle rendering.
 *
 * The Worker is CSP-locked (`default-src 'none'`), so a client-side theme
 * switcher is off the table - we resolve the effective theme on the server
 * from a URL param (`?theme=`) or a persisted cookie, and re-render the
 * three-choice pill group on every load. Reload cost is negligible vs
 * the dashboard's own 30s edge cache.
 *
 * Extracted from worker.js to keep the orchestrator file small.
 */

import { escape } from './worker.js';

/**
 * Effective theme for the request: `?theme=` query param wins, then cookie,
 * then 'auto' (no explicit stamp; OS prefers-color-scheme decides).
 * Never trusts input — only the three known values pass through.
 */
export function resolveTheme(url, cookieHeader) {
  const q = url.searchParams.get('theme');
  if (q === 'light' || q === 'dark') return q;
  if (q === 'auto') return 'auto';
  const m = cookieHeader.match(/(?:^|;\s*)theme=(light|dark)(?:;|$)/);
  if (m) return m[1];
  return 'auto';
}

/**
 * Three-pill toggle: Light / Dark / Auto. Server-rendered so no JS needed
 * (matches the page's CSP). Uses `<a>` links that carry the current URL
 * plus a `?theme=` param so the theme persists via cookie on the next load.
 *
 * `currentTheme` is one of 'light' | 'dark' | 'auto' (from resolveTheme) and
 * highlights the active choice. `requestUrl` is the incoming URL object
 * (or null when rendering from a mock/test without a real request).
 */
export function renderThemeToggle(currentTheme, requestUrl) {
  const link = (val, label, symbol) => {
    // Preserve all other query params (specifically ?key=) so the toggle
    // click doesn't 404. When requestUrl is missing (test/mock context),
    // fall back to `?theme=val` alone.
    let href;
    if (requestUrl) {
      const clone = new URL(requestUrl.toString());
      clone.searchParams.set('theme', val);
      href = clone.pathname + clone.search;
    } else {
      href = `?theme=${val}`;
    }
    const active = currentTheme === val ? ' theme-toggle-active' : '';
    return `<a class="theme-toggle-item${active}" href="${escape(href)}" title="${escape(label)}" aria-label="${escape(label)}${currentTheme === val ? ' (current)' : ''}">${symbol}</a>`;
  };
  return `<div class="theme-toggle" role="group" aria-label="Color theme">
    ${link('light', 'Light theme', 'L')}
    ${link('dark', 'Dark theme', 'D')}
    ${link('auto', 'Follow OS theme', 'A')}
  </div>`;
}
