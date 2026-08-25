/**
 * shift-dashboard - a mobile-friendly "what are the shifts doing" page.
 *
 * Cloudflare Worker. Static-shaped: one GET handler renders a single HTML page.
 * Fresh data every load (cached 30s at CF edge to stay well under GitHub's
 * 5000/hr authed rate limit even under mobile "pull-to-refresh" abuse).
 *
 * WHY THIS EXISTS
 *   Day/night-shift ship PRs into holding branches. The user is on their phone
 *   most of the day and wants a glance-view of "is anything running / stuck /
 *   waiting for me." Telegram gives push events but not a state snapshot;
 *   this fills that gap. Serves N projects from ONE URL (REPOS var below).
 *
 * AUTH
 *   Shared-secret query param `?key=<DASHBOARD_SECRET>`. Any request without
 *   it (or with a wrong one) returns 404 - no hints that something exists here.
 *   The data ITSELF (PR titles/status) is already visible to anyone with repo
 *   access via github.com; the secret exists so a leaked URL doesn't
 *   auto-attract crawlers. Rotate by re-`wrangler secret put DASHBOARD_SECRET`.
 *
 * SECRETS
 *   GH_TOKEN         - fine-grained PAT scoped to the repos in REPOS below.
 *                      Read scopes: Contents:read, Pull requests:read,
 *                      Issues:read, Actions:read, Metadata:read. Fine-grained
 *                      PATs must select "Only select repositories" and pick
 *                      each repo explicitly - broader OAuth/classic tokens work
 *                      too (broader than needed, but functional).
 *   DASHBOARD_SECRET - random string; used as `?key=` gate.
 *   Both set via: wrangler secret put <NAME>
 *
 * ENV VARS (wrangler.toml [vars])
 *   REPOS - comma-separated list e.g. "org/repo1,org/repo2". Falls back to
 *           REPO (single) for backward-compat with older single-repo installs.
 */

import { resolveTheme, renderThemeToggle } from './theme.js';
import {
  parseCron,
  humanizeCron,
  nextFireFromCron,
  humanizeUntil,
  renderSchedulePanel,
} from './cron.js';
import { syntheticShiftState } from './syntheticShiftState.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Constant-time-ish equality against the shared secret. Wrong / missing =
    // 404 with no body, no headers that give away the app.
    const key = url.searchParams.get('key') || '';
    if (!env.DASHBOARD_SECRET || !safeEqual(key, env.DASHBOARD_SECRET)) {
      return new Response('Not Found', { status: 404 });
    }

    // v7: POST /action/approve|reject|snooze - mutation surfaces gated by
    // an in-form `confirm=APPROVE|REJECT|SNOOZE` field so a stray click
    // never fires an action. Native forms only (no JS, CSP-safe).
    if (request.method === 'POST' && url.pathname.startsWith('/action/')) {
      return handleActionPost(request, env, url);
    }

    // Theme: explicit choice via ?theme=dark|light|auto persists to a cookie
    // so subsequent visits (mobile bookmark, laptop, etc.) inherit the choice
    // without needing the URL param again. `auto` clears the cookie so the OS
    // preference wins via prefers-color-scheme.
    const theme = resolveTheme(url, request.headers.get('Cookie') || '');
    const cookieHeader = request.headers.get('Cookie') || '';
    const extraHeaders = {};
    const explicit = url.searchParams.get('theme');
    const cookies = [];
    if (explicit === 'light' || explicit === 'dark') {
      cookies.push(`theme=${explicit}; Path=/; Max-Age=31536000; SameSite=Lax`);
    } else if (explicit === 'auto') {
      cookies.push('theme=; Path=/; Max-Age=0; SameSite=Lax');
    }

    // Flash toast: single-use cookie the POST handlers set. Read it here,
    // pass through to the renderer, then instruct the browser to clear it
    // so the toast only shows once.
    const flash = readFlashCookie(cookieHeader);
    if (flash) {
      cookies.push('flash=; Path=/; Max-Age=0; SameSite=Lax');
    }
    if (cookies.length) extraHeaders['Set-Cookie'] = cookies.join(', ');

    try {
      const data = await loadShiftState(env);
      return new Response(renderHtml(data, { theme, requestUrl: url, flash }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Edge-cache 30s to survive mobile refresh spam within GH rate limit.
          // NOTE: keep this `private, no-cache` on paths that carry a flash
          // toast so the toast doesn't stick in the shared cache. In practice
          // the ?key= makes each request unique, so max-age=30 is fine.
          'cache-control': flash ? 'private, no-store' : 'private, max-age=30',
          // Basic hardening (page is same-origin, no external assets).
          // form-action 'self' so the approve/reject/snooze forms can POST
          // back to this Worker (default 'none' would block them).
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          ...extraHeaders,
        },
      });
    } catch (err) {
      // 200 (not 5xx) so a mobile bookmark doesn't get "site down" cache; render
      // the error inline so the user sees the actual GH message on their phone.
      return new Response(renderError(err), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// POST /action/* handlers (v7)
// Each is a native form submission gated by confirm=<VERB>. On success we
// set a `flash=` cookie and 303-redirect back to `/`; the next GET reads it
// once and clears it. Failure lands on a small text/plain page so mobile
// still shows the reason.
// ─────────────────────────────────────────────────────────────────────────
async function handleActionPost(request, env, url) {
  // Parse the form body first so a malformed body fails fast without any
  // GitHub calls.
  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response('Bad Request: form body unreadable', { status: 400 });
  }
  const confirm = String(form.get('confirm') || '').trim().toUpperCase();
  const pr = Number(url.searchParams.get('pr') || '0');
  const repo = String(url.searchParams.get('repo') || '');
  const key = String(url.searchParams.get('key') || '');
  const action = url.pathname.slice('/action/'.length); // approve | reject | snooze
  const expected = action === 'approve' ? 'APPROVE' : action === 'reject' ? 'REJECT' : action === 'snooze' ? 'SNOOZE' : null;
  if (!expected) return new Response('Not Found', { status: 404 });
  if (confirm !== expected) {
    return actionFailFlash(url, key, `Type ${expected} in the confirm box to ${action} PR #${pr}.`);
  }
  if (!pr || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return actionFailFlash(url, key, `Bad request: missing pr or repo.`);
  }
  try {
    if (action === 'approve') {
      // Squash-merge, matching the existing shift-promotion pattern.
      await ghFetchJson(env, `https://api.github.com/repos/${repo}/pulls/${pr}/merge`, {
        method: 'PUT',
        body: { merge_method: 'squash' },
      });
      return actionSuccessFlash(url, key, `Merged PR #${pr} to holding branch.`);
    }
    if (action === 'reject') {
      // Choose the shift-appropriate label off the PR base ref. We fetch the
      // PR to read `base.ref`; small cost, but avoids labelling with the
      // wrong shift's variant.
      const details = await ghFetchJson(env, `https://api.github.com/repos/${repo}/pulls/${pr}`);
      const base = String(details?.base?.ref || '');
      const label = base.startsWith('night-shift-') ? 'night-shift:needs-human' : 'day-shift:needs-human';
      await ghFetchJson(env, `https://api.github.com/repos/${repo}/issues/${pr}/labels`, {
        method: 'POST',
        body: { labels: [label] },
      });
      // Leave an audit comment so the shift + a human reviewer see WHY.
      const note = String(form.get('note') || '').trim().slice(0, 500) || 'Rejected from dashboard.';
      await ghFetchJson(env, `https://api.github.com/repos/${repo}/issues/${pr}/comments`, {
        method: 'POST',
        body: { body: `**Rejected via shift-dashboard.**\n\n${note}\n\n_(labelled \`${label}\`; a human will re-plan.)_` },
      });
      return actionSuccessFlash(url, key, `Rejected PR #${pr} (labelled needs-human).`);
    }
    if (action === 'snooze') {
      await ghFetchJson(env, `https://api.github.com/repos/${repo}/issues/${pr}/labels`, {
        method: 'POST',
        body: { labels: ['snoozed-until-tomorrow'] },
      });
      return actionSuccessFlash(url, key, `Snoozed PR #${pr} until tomorrow.`);
    }
  } catch (err) {
    const msg = String(err.message || err).slice(0, 300);
    return actionFailFlash(url, key, `${action} failed: ${msg}`);
  }
  return new Response('Not Found', { status: 404 });
}

function actionSuccessFlash(url, key, msg) {
  return redirectWithFlash(url, key, 'ok', msg);
}
function actionFailFlash(url, key, msg) {
  return redirectWithFlash(url, key, 'err', msg);
}
function redirectWithFlash(url, key, kind, msg) {
  // Flash cookie is a single-use "toast" — value is `kind|msg` (pipe-separated)
  // and it's cleared on the next GET (see fetch handler above).
  const value = `${kind}|${msg}`.slice(0, 300);
  const enc = encodeURIComponent(value);
  const location = key ? `/?key=${encodeURIComponent(key)}` : '/';
  return new Response(null, {
    status: 303,
    headers: {
      location,
      'set-cookie': `flash=${enc}; Path=/; Max-Age=60; SameSite=Lax`,
    },
  });
}

function readFlashCookie(cookieHeader) {
  const m = String(cookieHeader || '').match(/(?:^|;\s*)flash=([^;]+)/);
  if (!m) return null;
  let raw;
  try { raw = decodeURIComponent(m[1]); } catch { return null; }
  const idx = raw.indexOf('|');
  if (idx < 0) return { kind: 'ok', msg: raw };
  const kind = raw.slice(0, idx);
  const msg = raw.slice(idx + 1);
  if (kind !== 'ok' && kind !== 'err') return null;
  return { kind, msg };
}

/**
 * Same as ghFetch but supports POST/PUT with JSON body. Kept separate so the
 * hot-path GET flow (ghFetch) stays trivially inspectable and the mutation
 * path is explicit at every call site.
 */
async function ghFetchJson(env, url, opts = {}) {
  const method = opts.method || 'GET';
  const init = {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'shift-dashboard-cf-worker',
      authorization: `Bearer ${env.GH_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    },
  };
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GH ${res.status} ${method} ${url}\n${body.slice(0, 400)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Parse REPOS (comma-separated) OR fall back to REPO (single). Trims + drops empties. */
function repoList(env) {
  const list = String(env.REPOS || env.REPO || 'your-org/your-repo')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['your-org/your-repo'];
}

/**
 * Load per-repo shift state. Each repo's 4 fetches happen in parallel; each
 * `soft`-wrapped so a missing PAT scope on one endpoint / repo hides only
 * that piece instead of erroring the whole page. Repos also load in parallel.
 */
async function loadShiftState(env) {
  // SYNTHETIC_PRS=1 short-circuits every GitHub call and returns a stable fixture
  // so the OSS repo is runnable end-to-end without a GH token. Used for local dev
  // (`SYNTHETIC_PRS=1 npx wrangler dev`), screenshots, and CI-preview builds.
  if (env.SYNTHETIC_PRS === '1' || env.SYNTHETIC_PRS === 1 || env.SYNTHETIC_PRS === true) {
    return syntheticShiftState();
  }
  const repos = repoList(env);
  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      const [dayPrs, nightPrs, nightRuns, dayRuns, dayMerged, nightMerged, nightCron, permissions] = await Promise.all([
        soft(ghListPrs(env, repo, 'day-shift-staging-')),
        soft(ghListPrs(env, repo, 'night-shift-staging-')),
        soft(ghListRuns(env, repo, 'night-shift-dispatch.yml', 5)),
        soft(ghListRuns(env, repo, 'day-shift-dispatch.yml', 5)), // may not exist
        // Recently merged-to-holding PRs. These are the "ready to test locally
        // OR promote to Staging" set - the tier of "landed" you cannot see
        // by only listing OPEN PRs, but that carries a clear next action.
        soft(ghListMergedPrs(env, repo, 'day-shift-staging-')),
        soft(ghListMergedPrs(env, repo, 'night-shift-staging-')),
        // Night-shift cron - read from the workflow YAML so the schedule
        // panel shows the real value not a hardcoded guess. Softens on
        // fetch failure so a missing Contents:Read scope only hides the
        // panel row, doesn't break the page.
        soft(ghFetchWorkflowCron(env, repo, 'night-shift-dispatch.yml')),
        // v7: probe write scope so the approve/reject/snooze buttons render
        // enabled only when the token can actually perform the mutation.
        // Missing → buttons render disabled with the token-widen tooltip.
        soft(ghProbePermissions(env, repo)),
      ]);
      return { repo, dayPrs, nightPrs, nightRuns, dayRuns, dayMerged, nightMerged, nightCron, permissions };
    }),
  );

  return {
    now: new Date().toISOString(),
    repos: perRepo,
  };
}

/**
 * Probe the token's scopes against a specific repo via GET /repos/{owner}/{name}.
 * The response includes a `permissions` field (`{pull, push, admin, maintain,
 * triage}`) whose values reflect what the *authenticated token* can do here.
 * We return `{push, admin, pull}` — `push` implies Contents:write + Issues:
 * write on fine-grained PATs, which is what the mutation buttons need.
 *
 * Called from loadShiftState per repo; a missing scope on one repo disables
 * mutations for that repo only — other repos stay clickable.
 */
async function ghProbePermissions(env, repo) {
  const meta = await ghFetch(env, `https://api.github.com/repos/${repo}`);
  const p = (meta && meta.permissions) || {};
  return {
    pull: p.pull === true,
    push: p.push === true,
    admin: p.admin === true,
  };
}

/**
 * Turn a rejecting promise into a resolving one whose value is
 * { error: <shortMsg> }. Consumers check `.error` first; if absent, treat
 * the value as the successful payload. Keeps the dashboard degradable per
 * section (Actions scope missing → dispatch history hidden, PRs still show).
 */
async function soft(p) {
  try {
    return await p;
  } catch (err) {
    const msg = String(err.message || err);
    return { error: msg.length > 300 ? msg.slice(0, 300) + '...' : msg };
  }
}

async function ghListPrs(env, repo, basePrefix) {
  // Fine-grained PATs can't use the /search/issues endpoint on private repos
  // (returns 422 "cannot be searched"). Use the direct /repos/*/pulls endpoint
  // which works with the plain Pull requests:Read scope, and filter by base
  // prefix client-side. The list endpoint doesn't take a `base:` prefix, only
  // an exact `base=<branch>`, so we list all open PRs (capped at 100) and
  // pick the ones whose baseRef starts with the shift's holding-branch prefix.
  const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`;
  const list = await ghFetch(env, url);
  const shortlist = list
    .filter((pr) => typeof pr.base?.ref === 'string' && pr.base.ref.startsWith(basePrefix))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      labels: (pr.labels || []).map((l) => l.name),
      isDraft: pr.draft || false,
      updatedAt: pr.updated_at,
      createdAt: pr.created_at,
      base: pr.base.ref,
      body: pr.body || '',
      // Agent Brain snapshot embedded by day-shift worker.mjs as an HTML
      // comment (`<!-- agent-brain:v1 {...} -->`). Null when the PR was
      // opened before brain wiring landed (Staging < ce77060f), or when
      // day-shift ran with DAY_SHIFT_AGENT_BRAIN off. See parseBrainSnapshot.
      brain: parseBrainSnapshot(pr.body || ''),
      testRoute: parseTestRoute(pr.body || ''),
      ticketId: parseTicketId(pr.title, pr.body || ''),
      // Enrichment fields populated by ghEnrichPr below.
      additions: null, deletions: null, changed_files: null, mergeable_state: null,
    }));

  // Per-PR enrichment. The list endpoint doesn't return additions/deletions/
  // changed_files/mergeable_state - only the per-PR detail endpoint does.
  // Answering the reviewer's "should I open this?" needs those numbers on the
  // dashboard so they don't have to click into github first. One extra API
  // call per PR is fine at ≤~15 open PRs (day+night) - well under GH's
  // 5000/hr authed budget with the 30s edge cache. Parallel via Promise.all;
  // per-PR failure yields nulls (row still renders, just without the deltas).
  await Promise.all(shortlist.map(async (pr) => {
    try {
      const d = await ghFetch(env, `https://api.github.com/repos/${repo}/pulls/${pr.number}`);
      pr.additions = typeof d.additions === 'number' ? d.additions : null;
      pr.deletions = typeof d.deletions === 'number' ? d.deletions : null;
      pr.changed_files = typeof d.changed_files === 'number' ? d.changed_files : null;
      pr.mergeable_state = typeof d.mergeable_state === 'string' ? d.mergeable_state : null;
    } catch { /* leave nulls; row still renders */ }
  }));

  return shortlist;
}

/**
 * Pull a ticket / issue reference out of a PR's title (or body as fallback).
 * Recognizes the common patterns we ship in this repo:
 *   "feat(scope): title (#1234)"     → 1234    (parenthesised trailing ref)
 *   "fix: something for #789"        → 789     (bare hash in title)
 *   "chore(deps): bump vite (1234)"  → null    (no #)
 * Falls back to a "Closes #1234" / "Fixes #1234" / "Refs #1234" scan in the
 * body if title has no marker. Returns null when nothing matches - which is
 * the honest "orphan PR" case (renders as "-" in the table, un-groupable).
 *
 * Kept deliberately narrow so it doesn't misread a code snippet in the body
 * that happens to contain `#1234`. The body scan requires a keyword prefix.
 */
function parseTicketId(title, body) {
  const t = String(title || '');
  const b = String(body || '');
  // 1. Parenthesised trailing ref, the day-shift/night-shift default format
  //    ("...title (#1234)")
  let m = t.match(/\(#(\d{2,6})\)\s*$/);
  if (m) return Number(m[1]);
  // 2. Bare `#1234` anywhere in title, e.g. "fix: X for #1234"
  m = t.match(/#(\d{2,6})\b/);
  if (m) return Number(m[1]);
  // 3. Body-side "Closes #1234" / "Fixes #1234" / "Refs #1234"
  m = b.match(/\b(?:closes|fixes|resolves|refs)\s+#(\d{2,6})\b/i);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Group PRs by their underlying ticket id so the same-ticket-two-attempts
 * case (day-shift AND night-shift both took a swing at #1290, or two
 * night-shift retries) collapses into ONE row on the dashboard with the
 * older attempts marked SUPERSEDED. The dashboard's #2 pain: "tickets night
 * shift did are not worth my time because I've already done them."
 *
 * Rules (all pure - no API calls):
 *   - Each unique ticketId becomes one group. Its `primary` is the
 *     most-recently-updated PR; older PRs on the same ticket are `superseded`.
 *   - PRs with no ticketId (parseTicketId returned null) each become their
 *     own singleton group under a synthetic key (`_orphan:<number>`).
 *   - `staleDays` (default 5) tags a primary PR as `isStale: true` when its
 *     `updatedAt` is older than that many days AND nothing newer has landed
 *     on the ticket - the "sitting for a week untouched" signal.
 *
 * Returned shape (stable, tested):
 *   [{ ticketId, primary: pr, superseded: [pr, ...], isStale: boolean, isDup: boolean }]
 *
 * Sorted: fresh actionable groups first, stale/superseded-only groups last.
 * Within each bucket, most-recently-updated first.
 */
function groupByTicket(prs, opts = {}) {
  const staleDays = opts.staleDays || 5;
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const staleMs = staleDays * 24 * 3600e3;
  const byKey = new Map();
  for (const pr of Array.isArray(prs) ? prs : []) {
    const key = pr.ticketId ? `t:${pr.ticketId}` : `_orphan:${pr.number}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(pr);
  }
  const groups = [];
  for (const [key, list] of byKey.entries()) {
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const primary = list[0];
    const superseded = list.slice(1);
    const ageMs = now - new Date(primary.updatedAt).getTime();
    const isStale = ageMs >= staleMs;
    const isDup = superseded.length > 0;
    groups.push({
      ticketId: key.startsWith('t:') ? Number(key.slice(2)) : null,
      primary, superseded, isStale, isDup,
    });
  }
  // Sort: actionable (not stale) first, then stale. Within each bucket,
  // newest-updated first so the freshest thing lands at the top.
  groups.sort((a, b) => {
    if (a.isStale !== b.isStale) return a.isStale ? 1 : -1;
    return new Date(b.primary.updatedAt).getTime() - new Date(a.primary.updatedAt).getTime();
  });
  return groups;
}

/**
 * Recently-merged-to-holding PRs. These are the "landed on a holding branch
 * in the last 48h" set - visible to the reviewer as "READY TO TEST or
 * PROMOTE" cards. Without this fetch, a merged PR silently vanishes from
 * the dashboard and the reviewer has no obvious next action.
 *
 * GitHub's `/pulls?state=closed` returns both merged and merely-closed;
 * we filter to merged only (mergedAt != null). Sorted newest-first server-side
 * via `sort=updated&direction=desc`. Client-side we cap the age to 48h -
 * older merges have almost certainly been promoted or superseded already.
 */
async function ghListMergedPrs(env, repo, basePrefix) {
  const url = `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`;
  const list = await ghFetch(env, url);
  const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
  return list
    .filter((pr) => pr.merged_at && new Date(pr.merged_at).getTime() >= cutoffMs)
    .filter((pr) => typeof pr.base?.ref === 'string' && pr.base.ref.startsWith(basePrefix))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      labels: (pr.labels || []).map((l) => l.name),
      mergedAt: pr.merged_at,
      updatedAt: pr.updated_at,
      base: pr.base.ref,
      brain: parseBrainSnapshot(pr.body || ''),
      testRoute: parseTestRoute(pr.body || ''),
      ticketId: parseTicketId(pr.title, pr.body || ''),
    }));
}

/**
 * Extract the day-shift-emitted test-route marker from a PR body. Returns
 * null on missing / malformed - the dashboard hides the "Test in browser"
 * link when no marker is present (change is not declared browser-testable).
 *
 * The producer format (tools/day-shift/worker.mjs openDraftPR, driven by
 * the worker's TEST_ROUTE line in progress.txt): `<!-- test-route:v1 {json} -->`.
 * Field whitelist enforced so a malicious PR body cannot inject rendering
 * attributes into the anchor tag downstream.
 */
function parseTestRoute(body) {
  const m = String(body || '').match(/<!--\s*test-route:v(\d+)\s+(\{[\s\S]*?\})\s*-->/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[2]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  // path is required, must be an absolute-ish path
  if (typeof parsed.path !== 'string' || !parsed.path.startsWith('/')) return null;
  const out = {
    schemaVersion: Number(m[1]) || 1,
    path: parsed.path.slice(0, 200),
    port: Number(parsed.port) > 0 && Number(parsed.port) < 65536 ? Number(parsed.port) : 8080,
  };
  if (typeof parsed.open === 'string' && parsed.open.trim()) out.open = parsed.open.trim().slice(0, 240);
  if (typeof parsed.hint === 'string' && parsed.hint.trim()) out.hint = parsed.hint.trim().slice(0, 240);
  return out;
}

/**
 * Render the "Test in browser" link for a PR card. Returns empty string
 * when no test-route was declared - the card then hides the link entirely.
 *
 * Link opens `http://localhost:<port><path>` in a new tab. Works IF the
 * reviewer has already checked out the branch and started the dev server
 * (the "Test locally" panel above carries that recipe). If the server
 * isn't up, the browser shows "connection refused" - implicit prompt to
 * start it.
 */
function renderTestBrowserLink(testRoute) {
  if (!testRoute) return '';
  const url = `http://localhost:${testRoute.port}${testRoute.path}`;
  const openHint = testRoute.open
    ? `<span class="tb-hint"> · ${escape(testRoute.open)}</span>`
    : '';
  const prereqHint = testRoute.hint
    ? `<div class="tb-prereq">${escape(testRoute.hint)}</div>`
    : '';
  return `<div class="test-browser">
    <a class="tb-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">🌐 Test in browser</a>
    <span class="tb-url">${escape(url)}</span>
    ${openHint}
    ${prereqHint}
  </div>`;
}

/**
 * Extract the day-shift-emitted brain snapshot from a PR body. Returns
 * null on missing / malformed - callers render an "-" or hide the section.
 *
 * The producer format (tools/day-shift/worker.mjs openDraftPR): a single
 * HTML comment line `<!-- agent-brain:v1 <compact JSON> -->` appended at
 * the end of the body. Kept short + hidden so it doesn't clutter the PR
 * for human reviewers, but discoverable by any tool with the PR body.
 */
function parseBrainSnapshot(body) {
  const m = String(body || '').match(/<!--\s*agent-brain:v(\d+)\s+(\{[\s\S]*?\})\s*-->/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[2]);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.ticketId !== 'number') return null;
    // Whitelist fields so a malicious PR body can't inject arbitrary keys
    // into downstream rendering.
    return {
      schemaVersion: Number(m[1]) || parsed.schemaVersion || 1,
      ticketId: parsed.ticketId,
      attempts: Number(parsed.attempts) || 0,
      lastOutcome: typeof parsed.lastOutcome === 'string' ? parsed.lastOutcome : null,
      lastDurationSec: Number(parsed.lastDurationSec) || null,
      hints: Number(parsed.hints) || 0,
      escalated: parsed.escalated === true,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch { return null; }
}

async function ghListRuns(env, repo, workflowFile, limit) {
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/` +
    `${workflowFile}/runs?per_page=${limit}`;
  const json = await ghFetch(env, url);
  return (json.workflow_runs || []).map((r) => ({
    id: r.id,
    status: r.status, // queued / in_progress / completed
    conclusion: r.conclusion, // success / failure / cancelled / null
    event: r.event, // schedule / workflow_dispatch / push
    branch: r.head_branch,
    url: r.html_url,
    createdAt: r.created_at,
    runNumber: r.run_number,
  }));
}

/**
 * Fetch a workflow file's cron expression via the GitHub Contents API.
 * Returns the raw cron string ("0 23 * * *"), or null when the file can't
 * be found, decoded, or has no cron schedule (e.g. workflow_dispatch only).
 *
 * We deliberately DON'T pull the whole YAML - the Contents API returns
 * base64-encoded file content and we only care about one line. Extract
 * cron via regex against the decoded text.
 */
async function ghFetchWorkflowCron(env, repo, workflowFile) {
  const url = `https://api.github.com/repos/${repo}/contents/.github/workflows/${workflowFile}`;
  const json = await ghFetch(env, url);
  if (!json || !json.content) return null;
  // atob is available in the CF Worker runtime.
  let text;
  try { text = atob(json.content.replace(/\n/g, '')); } catch { return null; }
  const m = text.match(/-\s*cron:\s*['"]([^'"]+)['"]/);
  return m ? m[1].trim() : null;
}

async function ghFetch(env, url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'shift-dashboard-cf-worker',
      authorization: `Bearer ${env.GH_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GH ${res.status} on ${url}\n${body.slice(0, 400)}`);
  }
  return res.json();
}

/** Render the HTML page. Single template literal - keep it inspectable.
 *
 * `d.repos` is an array of per-repo shift state (each: {repo, dayPrs, nightPrs,
 * nightRuns, dayRuns}). We render aggregate stat tiles across all repos, then
 * one section-group per repo below. Same URL / same bookmark serves N projects.
 */
function renderHtml(d, opts = {}) {
  const repos = Array.isArray(d.repos) ? d.repos : [];
  const theme = opts.theme || 'auto';        // 'light' | 'dark' | 'auto'
  const requestUrl = opts.requestUrl || null; // URL object, for theme toggle links
  const flash = opts.flash || null;           // { kind, msg } or null
  // The dashboard secret is needed by the mutation forms; extract it once
  // from the current request URL so every card can render its action forms.
  const key = requestUrl ? (requestUrl.searchParams.get('key') || '') : (opts.key || '');

  // Aggregate stats - sum across repos (or "?" if any repo's PR fetch errored,
  // since a missing count means we don't know the total).
  const anyDayErr = repos.some((r) => r.dayPrs?.error);
  const anyNightErr = repos.some((r) => r.nightPrs?.error);
  const dayCount = anyDayErr ? '?' : repos.reduce((n, r) => n + (Array.isArray(r.dayPrs) ? r.dayPrs.length : 0), 0);
  const nightCount = anyNightErr ? '?' : repos.reduce((n, r) => n + (Array.isArray(r.nightPrs) ? r.nightPrs.length : 0), 0);

  // Stamp data-theme when explicit; omit when auto so prefers-color-scheme wins.
  const htmlAttrs = (theme === 'light' || theme === 'dark') ? ` data-theme="${theme}"` : '';

  return `<!doctype html>
<html lang="en"${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1220" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f8fb" media="(prefers-color-scheme: light)">
<title>Shift dashboard${repos.length === 1 ? ' - ' + escape(repos[0].repo) : ''}</title>
<!-- Auto-refresh every 30s: cheap enough given the CF edge cache. -->
<meta http-equiv="refresh" content="30">
<style>
  /* ─────────────────────────────────────────────────────────────────────
     LOOP theme - see .claude/skills/shift-dashboard-design/SKILL.md
     Reference: designs.magicpath.ai/v1/nicely-noon-9235
     Palette + type + component conventions defined in the skill; every
     token below has a documented role. Add a token if you need a shade,
     never hardcode a hex in a component rule.
     ────────────────────────────────────────────────────────────────── */
  :root {
    color-scheme: light dark;
    /* Light theme is the DEFAULT so color-scheme correctly hints the UA
       for scrollbars etc; the dark theme (below) is the design's identity. */
    --bg:        #F7F8FA;
    --bg-nav:    #EDEFF3;
    --card:      #FFFFFF;
    --card-hi:   #F2F4F7;
    --pill:      #F2F4F7;
    --line:      #E4E7EC;
    --line-hi:   #D0D5DD;
    --fg:        #101828;
    --fg-hi:     #050B18;
    --muted:     #667085;
    --muted-hi:  #475467;
    --accent:    #0BB8AC;   /* cyan/teal (darkened for contrast on light) */
    --accent-dim:#088B82;
    --warn:      #E08804;
    --warn-dim:  #B36B03;
    --danger:    #C4442F;
    --danger-dim:#8F3222;
    --success:   #16A34A;
    /* Legacy aliases so existing rules keep working during the reskin. */
    --ok: var(--success); --fail: var(--danger); --run: var(--accent); --wait: var(--warn);
    /* Font stacks - inline (no CDN) per CSP default-src 'none'. */
    --font-body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, Roboto, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:        #0A0E12;
      --bg-nav:    #060A0D;
      --card:      #12171D;
      --card-hi:   #1A2028;
      --pill:      #1E2530;
      --line:      #1E2530;
      --line-hi:   #2A3340;
      --fg:        #E8ECEF;
      --fg-hi:     #FFFFFF;
      --muted:     #6B7580;
      --muted-hi:  #8A939E;
      --accent:    #14E3D5;   /* the identity cyan - hero action, live indicators, links */
      --accent-dim:#0EA89E;
      --warn:      #F5A623;
      --warn-dim:  #C77D0E;
      --danger:    #E86450;
      --danger-dim:#B14232;
      --success:   #4ADE80;
    }
  }
  /* Explicit-toggle overrides win over the media query, in both directions. */
  :root[data-theme="light"] {
    --bg:#F7F8FA;--bg-nav:#EDEFF3;--card:#FFFFFF;--card-hi:#F2F4F7;--pill:#F2F4F7;
    --line:#E4E7EC;--line-hi:#D0D5DD;--fg:#101828;--fg-hi:#050B18;
    --muted:#667085;--muted-hi:#475467;
    --accent:#0BB8AC;--accent-dim:#088B82;--warn:#E08804;--warn-dim:#B36B03;
    --danger:#C4442F;--danger-dim:#8F3222;--success:#16A34A;
  }
  :root[data-theme="dark"] {
    --bg:#0A0E12;--bg-nav:#060A0D;--card:#12171D;--card-hi:#1A2028;--pill:#1E2530;
    --line:#1E2530;--line-hi:#2A3340;--fg:#E8ECEF;--fg-hi:#FFFFFF;
    --muted:#6B7580;--muted-hi:#8A939E;
    --accent:#14E3D5;--accent-dim:#0EA89E;--warn:#F5A623;--warn-dim:#C77D0E;
    --danger:#E86450;--danger-dim:#B14232;--success:#4ADE80;
  }
  * { box-sizing: border-box }
  html, body { margin: 0; padding: 0 }
  body {
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 var(--font-body);
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }

  /* ─────────────────────────────────────────────────────────────────────
     App shell: sidebar (left) + main (right). Loop reference layout.
     Sidebar hides below 960px; top tab-nav takes over as nav on mobile.
     ────────────────────────────────────────────────────────────────── */
  .app-shell {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    min-height: 100vh;
    width: 100%;
  }
  .main-outer {
    padding: 20px 24px 96px;
    min-width: 0; /* prevents grid overflow from wide children */
    /* No max-width cap - the main region fills the viewport. On ultra-wide
       displays the two-column main-grid + rail-column ceiling below keeps
       columns from becoming unreadable, so we don't need an outer cap. */
    width: 100%;
  }
  /* Below md the sidebar becomes a collapsible top-strip disclosure — see
     the "Sidebar disclosure (mobile)" block further down. */
  /* Above md: sidebar visible, tab-nav redundant so hide it.
     Higher specificity than the base .tab-nav rule so source order doesn't
     matter (that rule is defined later in the file with display: flex). */
  @media (min-width: 961px) {
    .app-shell .tab-nav { display: none; }
  }

  /* ─────────────────────────────────────────────────────────────────────
     Sidebar. Loop-shaped: brand + WORKSPACE nav + coming-soon + user pill.
     ────────────────────────────────────────────────────────────────── */
  .sidebar {
    background: var(--bg-nav);
    border-right: 1px solid var(--line);
    padding: 20px 14px 16px;
    position: sticky; top: 0; height: 100vh;
    display: flex; flex-direction: column;
    overflow-y: auto;
  }
  .side-brand {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 8px 20px;
  }
  .side-logo {
    font-family: var(--font-mono); font-weight: 700; font-size: 15px;
    letter-spacing: 0.14em; color: var(--fg-hi);
  }
  .side-logo-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
    animation: pulse-dot 2.4s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1 }
    50% { opacity: 0.35 }
  }
  @media (prefers-reduced-motion) { .side-logo-dot { animation: none } }

  .side-section { display: flex; flex-direction: column; gap: 2px; margin-bottom: 20px }
  .side-eyebrow {
    font-family: var(--font-mono);
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em;
    color: var(--muted); padding: 8px 10px 6px;
  }
  .side-item {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 10px; border-radius: 6px;
    color: var(--fg); text-decoration: none;
    font-size: 13px; font-weight: 500;
    line-height: 1; min-height: 28px;
  }
  .side-item:hover { background: var(--card); color: var(--fg-hi) }
  .side-item-active {
    background: color-mix(in srgb, var(--accent) 12%, var(--card));
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
  }
  .side-item-disabled {
    color: var(--muted); cursor: default;
    opacity: 0.55;
  }
  .side-item-disabled:hover { background: transparent; color: var(--muted) }
  .side-icon {
    display: inline-flex; align-items: center; justify-content: center;
    flex: 0 0 16px; opacity: 0.9;
  }
  .side-label { flex: 1 1 auto }
  .side-count {
    background: var(--pill); color: var(--muted);
    font-size: 10.5px; padding: 1px 7px; border-radius: 100px;
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    min-width: 22px; text-align: center;
  }
  .side-item-active .side-count {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent);
  }
  .side-count-soon {
    text-transform: uppercase; letter-spacing: 0.08em; font-size: 9px;
    color: var(--muted); background: transparent; border: 1px solid var(--line);
  }
  .side-spacer { flex: 1 1 auto }
  /* Theme toggle: three L/D/A pill-buttons, server-side (URL param + cookie).
     CSP blocks JS so we cannot flip data-theme client-side; each item is a
     link that reloads with the new theme + persists via Set-Cookie. */
  .theme-toggle {
    display: flex; gap: 4px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 100px;
    padding: 3px;
    margin: 0 4px 8px;
  }
  .theme-toggle-item {
    flex: 1 1 auto; text-align: center;
    padding: 4px 0;
    border-radius: 100px;
    color: var(--muted); text-decoration: none;
    font-family: var(--font-mono); font-size: 11px; font-weight: 600;
    letter-spacing: 0.08em;
  }
  .theme-toggle-item:hover { color: var(--fg-hi); background: var(--pill) }
  .theme-toggle-item.theme-toggle-active {
    background: color-mix(in srgb, var(--accent) 22%, var(--card));
    color: var(--accent);
  }
  .side-user {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 8px;
    border-top: 1px solid var(--line);
    margin-top: 8px;
  }
  .side-avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border-radius: 8px;
    background: var(--pill); color: var(--fg-hi);
    font-family: var(--font-mono); font-weight: 600; font-size: 11px;
    letter-spacing: 0.06em;
  }
  .side-user-meta { display: flex; flex-direction: column; gap: 2px; font-size: 12px }
  .side-user-name { color: var(--fg-hi); font-weight: 500 }
  .side-user-status {
    color: var(--muted); font-size: 10.5px;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .side-user-status .dot {
    width: 6px; height: 6px; border-radius: 50%;
    box-shadow: 0 0 4px currentColor;
  }

  /* ─────────────────────────────────────────────────────────────────────
     Sidebar disclosure (mobile).
     The sidebar wraps its content in <details>. On desktop the summary is
     hidden and the content is force-shown so the sidebar reads as always
     open. On narrow viewports the summary becomes a compact brand+hamburger
     bar the user can tap to expand the nav - triage cards land right below
     it instead of a full-viewport sidebar column.
     JS-free (matches the page's default-src 'none' CSP).
     ────────────────────────────────────────────────────────────────── */
  .sidebar-collapse { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .sidebar-summary { display: none; }
  .sidebar-content { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }

  @media (max-width: 960px) {
    /* Sidebar becomes a top strip on mobile - one compact row until tapped.
       Rules below beat the base .sidebar block via source order (later wins
       at equal specificity). */
    .app-shell { grid-template-columns: 1fr; }
    .main-outer { padding: 16px 12px 96px; }

    .sidebar {
      position: static; height: auto;
      padding: 4px 12px;
      border-right: none;
      border-bottom: 1px solid var(--line);
    }
    /* Hide the redundant in-content brand row on mobile - the summary bar
       already shows SHIFTS. */
    .sidebar-content .side-brand { display: none; }

    .sidebar-summary {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; padding: 10px 4px;
      cursor: pointer; list-style: none; user-select: none;
      color: var(--fg-hi);
    }
    /* Kill the native disclosure triangle on both engines. */
    .sidebar-summary::-webkit-details-marker { display: none; }
    .sidebar-summary::marker { content: ''; }
    .sidebar-summary-brand { display: inline-flex; align-items: center; gap: 8px; }
    .sidebar-summary-hamburger {
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--muted);
    }
    /* When the details is open on mobile, rotate the hamburger to signal
       "tap to close" without needing a separate icon. */
    .sidebar-collapse[open] .sidebar-summary-hamburger { color: var(--fg-hi); }
    /* Give the expanded content some breathing room and cap its height so
       it doesn't push the triage cards off-screen when open. */
    .sidebar-collapse[open] .sidebar-content {
      padding: 8px 0 12px;
      max-height: 70vh; overflow-y: auto;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     Two-column main grid (main content + right rail). Rail collapses
     under main between 720px and 1160px; single-column below.
     ────────────────────────────────────────────────────────────────── */
  .main-grid {
    display: grid;
    /* Main column takes remaining space; rail is capped at 380px so it
       stops growing on ultra-wide displays. Below 1160px the layout
       collapses to a single column and the rail floats above main. */
    grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
    gap: 24px;
    align-items: start;
  }
  @media (max-width: 1160px) {
    .main-grid { grid-template-columns: 1fr; }
    .rail { order: -1; } /* rail first on medium so attention lands above main */
  }
  .rail { display: flex; flex-direction: column; gap: 16px; min-width: 0 }
  .panel {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; padding: 14px 16px;
  }
  .panel-hd {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; margin-bottom: 12px;
  }
  .panel-hd h2 { margin: 0 }
  .panel-hd h2::before { content: none } /* panel already has its own visual marker */
  .panel-count {
    color: var(--muted); font-size: 11px;
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    background: var(--pill); padding: 2px 8px; border-radius: 100px;
  }
  .panel-status {
    color: var(--muted); font-size: 10.5px;
    font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.10em;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .panel-status.live { color: var(--accent) }

  /* Schedule panel: at the TOP of the rail. Answers "when does each shift
     fire?" Info-value first - the question you'd otherwise have to open
     the workflow YAML to answer. */
  .panel-schedule { border-left: 3px solid var(--accent-dim) }
  .sched-list { display: flex; flex-direction: column; gap: 12px }
  .sched-row {
    display: grid;
    grid-template-columns: 62px 1fr;
    gap: 12px;
    align-items: start;
  }
  .sched-tag {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 8px; border-radius: 100px;
    background: var(--pill); border: 1px solid var(--line);
    font-family: var(--font-mono); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.10em;
    color: var(--fg); font-weight: 600;
    white-space: nowrap;
  }
  .sched-tag .dot {
    width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px;
    box-shadow: 0 0 5px currentColor;
  }
  .sched-body { display: flex; flex-direction: column; gap: 3px; min-width: 0 }
  .sched-line {
    color: var(--fg-hi); font-size: 13px; font-weight: 500;
    font-family: var(--font-mono);
  }
  .sched-meta {
    color: var(--muted); font-size: 11px;
    font-family: var(--font-mono);
    display: flex; gap: 4px 12px; flex-wrap: wrap;
  }
  .sched-next { color: var(--accent) }
  .sched-foot {
    margin-top: 12px; padding-top: 10px;
    border-top: 1px dashed var(--line-hi);
    color: var(--muted); font-size: 10.5px; line-height: 1.55;
  }
  .sched-foot code {
    background: var(--pill); padding: 1px 5px; border-radius: 3px;
    font-family: var(--font-mono); font-size: 10px;
    color: var(--fg);
  }
  /* Attention panel: red-left-border callout for needs-human PRs */
  .panel-attention {
    border-left: 3px solid var(--danger);
    background: color-mix(in srgb, var(--danger) 5%, var(--card));
  }
  .panel-attention .panel-hd h2 { color: var(--danger) }
  .attn-list { display: flex; flex-direction: column; gap: 8px }
  .attn-item {
    display: block; text-decoration: none;
    background: color-mix(in srgb, var(--danger) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 22%, var(--line));
    border-radius: 6px; padding: 8px 10px;
    color: var(--fg);
  }
  .attn-item:hover {
    background: color-mix(in srgb, var(--danger) 10%, var(--card));
    color: var(--fg-hi);
  }
  .attn-title {
    display: flex; align-items: baseline; gap: 6px;
    font-size: 12px; font-family: var(--font-mono);
  }
  .attn-num { color: var(--danger); font-weight: 600 }
  .attn-repo { color: var(--muted); font-size: 11px }
  .attn-desc { font-size: 13px; line-height: 1.35; margin-top: 3px }
  .attn-more {
    color: var(--muted); font-size: 11px; padding: 4px 4px 0;
    font-family: var(--font-mono);
  }

  /* Stream panel: terminal-styled live feed */
  .panel-stream .stream-list {
    display: flex; flex-direction: column; gap: 6px;
    font-family: var(--font-mono); font-size: 11.5px;
  }
  .stream-row {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 2px;
    border-bottom: 1px dashed color-mix(in srgb, var(--line) 60%, transparent);
  }
  .stream-row:last-child { border-bottom: none }
  .stream-dot {
    width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px;
    box-shadow: 0 0 5px currentColor;
  }
  .stream-shift {
    color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em;
    font-size: 10px; width: 40px; flex: 0 0 40px;
  }
  .stream-msg {
    flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .stream-msg a { color: var(--fg-hi); text-decoration: none }
  .stream-msg a:hover { color: var(--accent) }
  .stream-repo { color: var(--muted); margin-left: 4px }
  .stream-arrow { color: var(--muted); margin: 0 4px }
  .stream-status { color: var(--fg) }
  .stream-when {
    color: var(--muted); font-size: 10.5px; margin-left: auto;
    flex: 0 0 auto; white-space: nowrap;
  }

  /* Scope anchors for sidebar/tab jumps */
  #top, #ready, #open, #history, #attention { scroll-margin-top: 24px }
  code { font-family: var(--font-mono); font-size: 0.92em }
  h1 {
    font-size: 30px; line-height: 1.1; letter-spacing: -0.01em;
    font-weight: 600; color: var(--fg-hi); margin: 8px 0 4px;
    text-wrap: balance;
  }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 20px }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px }
  @media (min-width: 720px) {
    .grid { grid-template-columns: repeat(4, 1fr); }
  }
  .stat {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px;
  }
  .stat .n {
    font-size: 30px; font-weight: 700; line-height: 1.05; color: var(--fg-hi);
    font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
  }
  .stat .l {
    color: var(--muted); font-size: 11px; margin-top: 4px;
    font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em;
  }
  section { margin-top: 22px }
  /* h2 = section eyebrow (mono uppercase, muted). Kept as h2 for semantic
     structure; the Loop reference pairs it with a readable heading below,
     but our sections are short-titled so the eyebrow doubles as the label. */
  h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .14em;
    color: var(--muted); margin: 22px 2px 10px;
    font-family: var(--font-mono); font-weight: 500;
  }
  h2::before {
    content: "◇ "; color: var(--accent); opacity: 0.7;
    margin-right: 2px;
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 10px;
  }
  .card .row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
  .num {
    font-weight: 700; font-family: var(--font-mono); color: var(--fg-hi);
    font-size: 13px;
  }
  .title {
    flex: 1 1 100%; margin-top: 6px; color: var(--fg); text-decoration: none;
    font-weight: 500; line-height: 1.35;
  }
  .title:hover { color: var(--accent); text-decoration: none }
  .pills { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px }
  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--pill); color: var(--fg);
    font-size: 10.5px; padding: 3px 9px; border-radius: 100px;
    border: 1px solid var(--line);
    font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em;
    font-weight: 500;
  }
  .pill.draft { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)) }
  .pill.clean { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--line)) }
  .pill.human { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)) }
  .brain-row {
    color: var(--muted); font-size: 12px; margin-top: 10px;
    padding-top: 8px; border-top: 1px dashed var(--line-hi);
    font-family: var(--font-mono);
  }
  .brain-outcome { font-weight: 600 }
  .brain-outcome-complete { color: var(--success) }
  .brain-outcome-stuck { color: var(--danger) }
  .brain-outcome-out-of-scope { color: var(--warn) }
  .brain-outcome-failed-ci { color: var(--danger) }
  .brain-outcome-superseded, .brain-outcome-merged { color: var(--muted) }
  /* Test-in-browser link: the prominent affordance the reviewer taps to
     open the change in localhost. Loop-accented (subtle cyan tint). */
  .test-browser {
    margin-top: 10px; padding: 10px 12px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
    border-radius: 8px;
    display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px;
    font-size: 12px;
  }
  .test-browser .tb-link {
    color: var(--accent); text-decoration: none; font-weight: 600; font-size: 13px;
    white-space: nowrap;
  }
  .test-browser .tb-link:hover { text-decoration: underline }
  .test-browser .tb-url {
    color: var(--muted); font-family: var(--font-mono);
    font-size: 11px;
  }
  .test-browser .tb-hint { color: var(--fg); font-size: 12px }
  .test-browser .tb-prereq {
    width: 100%; margin-top: 4px; color: var(--warn); font-size: 11px; font-style: italic;
  }
  .status-ok { color: var(--success) }
  .status-fail { color: var(--danger) }
  .status-run { color: var(--accent) }
  .status-wait { color: var(--warn) }
  .empty {
    color: var(--muted); font-style: italic; padding: 10px 4px;
    font-family: var(--font-mono); font-size: 12px;
  }
  /* Inline scope-missing warning (per-section fallback). */
  .warn {
    background: color-mix(in srgb, var(--warn) 6%, var(--card));
    border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--line));
    border-left: 3px solid var(--warn); border-radius: 8px;
    padding: 12px 14px; color: var(--fg); font-size: 13px;
  }
  .warn code { background: var(--pill); padding: 1px 6px; border-radius: 4px; font-size: 12px; font-family: var(--font-mono) }
  .warn details { margin-top: 6px }
  .warn summary { color: var(--muted); font-size: 12px; cursor: pointer }
  .warn pre {
    background: var(--bg); border: 1px solid var(--line-hi); border-radius: 4px;
    padding: 8px 10px; overflow-x: auto; font-size: 11px; margin-top: 6px;
    white-space: pre-wrap; font-family: var(--font-mono);
  }
  /* Dispatch history rows - terminal-inspired list */
  .runs { display: grid; gap: 6px }
  .run-row {
    display: flex; align-items: center; gap: 10px; font-size: 13px;
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 12px; font-family: var(--font-mono);
  }
  .run-row .dot {
    width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px;
    box-shadow: 0 0 6px currentColor;
  }
  .run-row a { color: var(--fg); text-decoration: none }
  .run-row a:hover { color: var(--accent) }
  .run-row .when { color: var(--muted); margin-left: auto; font-size: 11px }
  /* Repo section grouping */
  .repo {
    background: transparent; margin-top: 32px;
    padding-top: 16px; border-top: 1px solid var(--line-hi);
  }
  .repo:first-of-type { border-top: 0; margin-top: 8px }
  .repo-hd {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    margin: 4px 0 8px;
  }
  .repo-hd::before {
    content: "▸"; color: var(--accent); font-family: var(--font-mono);
    font-size: 13px; opacity: 0.8;
  }
  .repo-hd a {
    font-weight: 600; font-size: 17px; text-decoration: none; color: var(--fg-hi);
    letter-spacing: -0.005em;
  }
  .repo-hd a:hover { color: var(--accent) }
  .repo-hd .repo-counts { color: var(--muted); font-size: 12px }
  /* Sticky tab-nav. Anchors that jump to the first repo's matching section.
     Loop-styled: pill tabs on the surface, with an accent underline on
     hover. Sticky so the user can jump between sections mid-scroll. */
  .tab-nav {
    position: sticky; top: 0; z-index: 10;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(6px);
    padding: 12px 0 10px;
    display: flex; gap: 6px; flex-wrap: wrap;
    border-bottom: 1px solid var(--line);
    margin: -20px -16px 16px; padding-left: 16px; padding-right: 16px;
  }
  .tab-nav .tab {
    background: var(--card); border: 1px solid var(--line);
    padding: 7px 14px; border-radius: 100px;
    color: var(--fg); text-decoration: none;
    font-size: 12.5px; font-weight: 500;
    display: inline-flex; align-items: center; gap: 6px;
    white-space: nowrap;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }
  .tab-nav .tab:hover {
    background: var(--card-hi); border-color: var(--line-hi); color: var(--fg-hi);
  }
  .tab-nav .tab .tab-count {
    color: var(--muted); font-size: 11px;
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
  }
  .tab-nav .tab .dot {
    width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px;
    box-shadow: 0 0 6px currentColor;
  }
  .dot-success { background: var(--success); color: var(--success) }
  .dot-accent  { background: var(--accent);  color: var(--accent) }
  .dot-warn    { background: var(--warn);    color: var(--warn) }
  .dot-danger  { background: var(--danger);  color: var(--danger) }
  .dot-muted   { background: var(--muted);   color: transparent }
  /* Sections targeted by tabs get scroll-margin so the sticky nav doesn't hide their heading */
  #ready, #open, #history { scroll-margin-top: 72px }

  /* Next-actions strip: single line summary at the top of the page so the
     user sees the world state before scrolling. */
  .next-actions {
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    padding: 10px 14px; font-size: 12.5px; color: var(--fg);
    margin: 4px 0 22px; display: flex; flex-wrap: wrap; gap: 6px 16px;
    align-items: baseline;
  }
  .next-actions strong {
    font-weight: 500; font-family: var(--font-mono);
    text-transform: uppercase; letter-spacing: 0.10em;
    font-size: 10.5px; color: var(--muted);
  }
  .next-actions .na-quiet { color: var(--muted); font-style: italic }
  .next-actions .na-num {
    color: var(--accent); font-weight: 700;
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-size: 14px; margin-right: 2px;
  }

  /* MERGED-to-holding card: left-border accent identifies state at a glance.
     Loop's "state-carrying card" pattern - the border tints per state. */
  .card.merged {
    border-left: 3px solid var(--success);
    background: color-mix(in srgb, var(--success) 3%, var(--card));
  }
  .pill.merged {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 45%, var(--line));
    background: color-mix(in srgb, var(--success) 10%, var(--pill));
  }

  /* Action panels (Test locally / Promote to Staging foldouts) */
  .action-panels { margin-top: 12px; display: flex; flex-direction: column; gap: 6px }
  details.action {
    background: var(--pill); border: 1px solid var(--line); border-radius: 6px;
    font-size: 13px;
  }
  details.action summary {
    padding: 7px 12px; cursor: pointer; color: var(--fg); font-weight: 500;
    list-style: none; user-select: none;
    display: flex; align-items: center; gap: 8px;
  }
  details.action summary::-webkit-details-marker { display: none }
  details.action summary::before {
    content: "▸"; color: var(--muted); font-size: 10px;
    font-family: var(--font-mono);
    transition: transform 0.12s ease;
    display: inline-block;
  }
  details.action[open] > summary::before {
    content: "▾"; color: var(--accent);
  }
  details.action[open] {
    background: var(--card-hi); border-color: var(--line-hi);
  }
  details.action .body { padding: 4px 12px 12px }
  details.action .hint {
    color: var(--muted); font-size: 11px; margin: 0 0 8px;
    line-height: 1.5;
  }
  details.action pre.recipe {
    background: var(--bg); border: 1px solid var(--line-hi); border-radius: 4px;
    padding: 10px 12px; margin: 0; overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 11.5px; line-height: 1.55; color: var(--fg);
    /* click-to-select-all: no JS needed for the copy affordance */
    user-select: all;
    white-space: pre;
  }
  details.action .link-row {
    margin-top: 10px; font-size: 12px;
  }
  details.action .link-row a {
    color: var(--accent); text-decoration: none; font-weight: 500;
    font-family: var(--font-mono);
  }
  details.action .link-row a:hover { text-decoration: underline }

  /* Footer */
  footer {
    margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line);
    color: var(--muted); font-size: 11px; text-align: center;
    font-family: var(--font-mono); letter-spacing: 0.04em;
  }
  a { color: inherit }
  /* Focus ring uses the accent for keyboard nav visibility */
  a:focus-visible, .tab-nav .tab:focus-visible, details.action summary:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px;
  }

  /* ─────────────────────────────────────────────────────────────────────
     V4 UX rework - dense PR table + real section hierarchy.
     Solves the 4 pains: (1) rich per-row info so the dashboard answers
     "should I open this?" WITHOUT clicking to github, (2) ticket-grouped
     duplicate/supersede/stale callouts so already-done work fades, (3)
     one line per PR (was: 100+ px card) so 15 PRs fit above the fold,
     (4) a real visual hierarchy - heavy section header + heavy title,
     light muted meta + tabular numbers.
     ────────────────────────────────────────────────────────────────── */

  /* Section header - eyebrow + real h2 + right-side count strip.
     Replaces the old h2 (which was itself an 11px mono eyebrow doing
     double-duty). Now a real 18px heavy header lands the eye, with a
     small mono eyebrow above for grouping context. */
  .section-hd {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; margin: 28px 0 12px; flex-wrap: wrap;
  }
  .section-hd-l { display: flex; flex-direction: column; gap: 2px; min-width: 0 }
  .section-hd .eyebrow {
    font-family: var(--font-mono);
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em;
    color: var(--muted); font-weight: 500;
  }
  .section-hd .eyebrow .dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    margin-right: 6px; vertical-align: 1px;
  }
  .section-hd h3 {
    font-size: 18px; font-weight: 600; line-height: 1.2;
    color: var(--fg-hi); margin: 0; letter-spacing: -0.01em;
  }
  .section-hd .counts {
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-size: 11px; color: var(--muted);
  }
  .section-hd .counts .c-item {
    background: var(--pill); padding: 3px 9px; border-radius: 100px;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .section-hd .counts .c-item.hot { color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--line)); background: color-mix(in srgb, var(--warn) 6%, var(--pill)) }
  .section-hd .counts .c-item.blocker { color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--line)); background: color-mix(in srgb, var(--danger) 6%, var(--pill)) }
  .section-hd .counts .c-item.dim { opacity: 0.7 }

  /* Slim state-strip: replaces the 4-KPI grid. One line, mono, tabular.
     Numbers pop in accent/warn/danger by role so the eye lands on
     WHAT NEEDS DOING, not on decorative panels. */
  .state-strip {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; padding: 12px 16px;
    display: flex; flex-wrap: wrap; gap: 10px 22px;
    align-items: baseline; margin: 6px 0 22px;
    font-family: var(--font-mono); font-size: 12px;
  }
  .state-strip .st { display: inline-flex; align-items: baseline; gap: 6px }
  .state-strip .st-n {
    font-size: 20px; font-weight: 700; color: var(--fg-hi);
    font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
  }
  .state-strip .st-l {
    color: var(--muted); font-size: 10.5px;
    text-transform: uppercase; letter-spacing: 0.10em;
  }
  .state-strip .st.attn .st-n { color: var(--danger) }
  .state-strip .st.ready .st-n { color: var(--success) }
  .state-strip .st.stale .st-n { color: var(--warn) }
  .state-strip .st-sep {
    width: 1px; height: 24px; background: var(--line);
    align-self: center;
  }

  /* PR TABLE ── each PR is one <details> whose <summary> is the row.
     Native disclosure = no JS = CSP clean. Click summary → expand for
     brain/test-browser/superseded list. */
  .pr-table {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 10px;
    /* Horizontal-scroll fallback so narrow viewports can pan when the row
       grid can't shrink below its minimum readable width. On desktop the
       min-width fits comfortably and no scroll appears. */
    overflow-x: auto;
    overflow-y: hidden;
  }
  .pr-thead, details.pr > summary {
    /* Anchor a minimum readable width so columns keep their sizes on
       narrow containers; the .pr-table wrapper handles the horizontal
       scroll. */
    min-width: 720px;
  }
  .pr-thead {
    display: grid;
    grid-template-columns: 26px 68px 60px 44px minmax(0, 1fr) 92px 100px 92px;
    gap: 10px; padding: 8px 14px;
    font-family: var(--font-mono); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.10em;
    color: var(--muted);
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--pill) 40%, transparent);
  }
  .pr-thead > span { min-width: 0 }
  .pr-thead .th-r { text-align: right }
  details.pr {
    border-bottom: 1px solid var(--line);
    background: var(--card);
  }
  details.pr:last-child { border-bottom: none }
  details.pr[open] { background: color-mix(in srgb, var(--pill) 40%, var(--card)) }
  details.pr > summary {
    display: grid;
    grid-template-columns: 26px 68px 60px 44px minmax(0, 1fr) 92px 100px 92px;
    gap: 10px; padding: 10px 14px; cursor: pointer;
    align-items: center; list-style: none;
    font-size: 13px; line-height: 1.35;
    min-height: 40px;
  }
  details.pr > summary::-webkit-details-marker { display: none }
  details.pr:hover > summary { background: color-mix(in srgb, var(--pill) 50%, var(--card)) }
  details.pr > summary > * { min-width: 0 }
  .pr-caret {
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--muted); font-family: var(--font-mono); font-size: 10px;
    transition: transform 0.12s ease;
    width: 26px;
  }
  details.pr[open] > summary .pr-caret { color: var(--accent); transform: rotate(90deg) }
  .pr-num {
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    color: var(--fg-hi); font-weight: 600; font-size: 12px;
    letter-spacing: -0.005em;
  }
  .pr-ticket {
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    color: var(--muted); font-size: 11px;
  }
  .pr-ticket a { color: var(--muted); text-decoration: none }
  .pr-ticket a:hover { color: var(--accent) }
  .pr-ticket-orphan { color: var(--muted); opacity: 0.45 }
  .pr-shift {
    font-family: var(--font-mono); font-size: 9.5px;
    text-transform: uppercase; letter-spacing: 0.10em;
    color: var(--muted);
    padding: 2px 7px; border-radius: 100px;
    background: var(--pill); border: 1px solid var(--line);
    text-align: center;
  }
  .pr-shift.night { color: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 25%, var(--line)) }
  .pr-title-cell {
    display: flex; align-items: center; gap: 8px;
    min-width: 0;
  }
  .pr-title-cell .t {
    font-weight: 600; color: var(--fg-hi); font-size: 13px;
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  details.pr[open] > summary .pr-title-cell .t { white-space: normal }
  .pr-title-cell .flag {
    flex: 0 0 auto;
    font-family: var(--font-mono); font-size: 9.5px;
    text-transform: uppercase; letter-spacing: 0.10em;
    padding: 2px 7px; border-radius: 100px;
  }
  .pr-title-cell .flag.dup {
    color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--line));
  }
  .pr-title-cell .flag.stale {
    color: var(--muted); background: transparent;
    border: 1px solid var(--line);
  }
  .pr-delta {
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-size: 11px; text-align: right;
    color: var(--muted); white-space: nowrap;
  }
  .pr-delta .files { color: var(--muted-hi); font-weight: 500 }
  .pr-delta .plus { color: var(--success) }
  .pr-delta .minus { color: var(--danger) }
  .pr-delta .delta-total { color: var(--fg); font-weight: 500 }
  .pr-delta .delta-total.big { color: var(--warn) }
  .pr-delta .delta-total.huge { color: var(--danger) }
  .pr-delta .empty { opacity: 0.4 }
  .pr-status {
    font-family: var(--font-mono); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.10em;
    padding: 3px 9px; border-radius: 100px;
    text-align: center; white-space: nowrap;
    background: var(--pill); border: 1px solid var(--line); color: var(--muted);
  }
  .pr-status.clean { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--line)); background: color-mix(in srgb, var(--success) 8%, var(--pill)) }
  .pr-status.human { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); background: color-mix(in srgb, var(--danger) 10%, var(--pill)) }
  .pr-status.draft { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); background: color-mix(in srgb, var(--warn) 8%, var(--pill)) }
  .pr-status.conflict { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); background: color-mix(in srgb, var(--danger) 8%, var(--pill)) }
  .pr-when {
    font-family: var(--font-mono); font-size: 10.5px;
    color: var(--muted); text-align: right;
    font-variant-numeric: tabular-nums; white-space: nowrap;
  }

  /* Stale row: dimmed. Signal: "you probably don't need to review this today." */
  details.pr.stale {
    opacity: 0.55;
    background: color-mix(in srgb, var(--pill) 25%, var(--card));
  }
  details.pr.stale:hover, details.pr.stale[open] { opacity: 1 }
  details.pr.stale .pr-num, details.pr.stale .pr-title-cell .t { color: var(--muted-hi) }

  /* Expanded body under a PR row */
  details.pr .pr-body {
    padding: 6px 16px 16px 40px;
    border-top: 1px dashed var(--line-hi);
    background: color-mix(in srgb, var(--bg) 25%, var(--card));
  }
  details.pr .pr-body .pr-body-row {
    display: flex; flex-wrap: wrap; gap: 8px 16px;
    font-size: 12px; color: var(--muted); margin-bottom: 8px;
    font-family: var(--font-mono);
  }
  details.pr .pr-body .pr-body-row a {
    color: var(--accent); text-decoration: none;
  }
  details.pr .pr-body .pr-body-row a:hover { text-decoration: underline }
  details.pr .pr-body .brain-row {
    margin-top: 4px; padding-top: 0; border-top: none;
  }

  /* Superseded sub-row: nested inside the expanded body. Muted heavily
     so it reads as "already-known-about work." */
  .super-list {
    margin-top: 8px; padding-top: 8px;
    border-top: 1px dashed var(--line-hi);
    display: flex; flex-direction: column; gap: 6px;
  }
  .super-list .super-title {
    font-family: var(--font-mono); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.10em;
    color: var(--warn);
  }
  .super-item {
    display: flex; align-items: center; gap: 10px;
    font-size: 12px; font-family: var(--font-mono);
    padding: 4px 0;
    color: var(--muted);
  }
  .super-item .n {
    color: var(--muted-hi); font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .super-item .t {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--fg);
  }
  .super-item .when { font-size: 10.5px }
  .super-item a { color: inherit; text-decoration: none }
  .super-item a:hover { color: var(--accent) }

  /* Below-md: the table stops being a table and becomes a stack of
     compact cards. Grid columns collapse into a two-line layout per row. */
  @media (max-width: 720px) {
    .pr-thead { display: none }
    details.pr > summary {
      grid-template-columns: 26px 1fr auto;
      grid-template-areas:
        "caret title status"
        ".     meta  when";
      row-gap: 4px;
    }
    details.pr > summary .pr-caret { grid-area: caret }
    details.pr > summary .pr-title-cell { grid-area: title }
    details.pr > summary .pr-status { grid-area: status }
    details.pr > summary .pr-when { grid-area: when; text-align: left }
    /* Pack num/ticket/shift/delta into a single meta row on mobile */
    details.pr > summary .pr-num,
    details.pr > summary .pr-ticket,
    details.pr > summary .pr-shift,
    details.pr > summary .pr-delta { grid-area: meta; display: inline }
    details.pr > summary .pr-num::after,
    details.pr > summary .pr-ticket::after { content: " · "; color: var(--muted) }
  }

  /* Bump the page hero heavier so the h1 is unambiguously the loudest
     thing above the fold - Pain #4. */
  h1 { font-size: 34px; font-weight: 700; letter-spacing: -0.015em }

  /* ═══════════════════════════════════════════════════════════════════
     v7 - 5th-grader triage view
     ═══════════════════════════════════════════════════════════════════ */

  /* Flash toast — one-visit banner after an approve/reject/snooze. */
  .flash {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; border-radius: 8px;
    margin: 12px 0 20px;
    font-size: 14px; font-weight: 500;
    border: 1px solid var(--line);
  }
  .flash-ok {
    background: color-mix(in srgb, var(--success) 12%, var(--card));
    border-color: color-mix(in srgb, var(--success) 45%, var(--line));
    color: var(--fg-hi);
  }
  .flash-err {
    background: color-mix(in srgb, var(--danger) 12%, var(--card));
    border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
    color: var(--fg-hi);
  }
  .flash-icon { font-size: 16px }
  .flash-msg { flex: 1 1 auto }

  /* Triage strip — replaces the noisy 6-metric state strip at the top */
  .tri-strip {
    background: var(--card); border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: 8px; padding: 12px 16px;
    display: flex; flex-wrap: wrap; gap: 8px 16px;
    align-items: baseline;
    margin: 6px 0 20px;
    font-size: 13px;
  }
  .tri-strip-lead {
    font-family: var(--font-mono);
    text-transform: uppercase; letter-spacing: 0.10em;
    font-size: 11px; color: var(--muted); font-weight: 600;
  }
  .tri-strip-item {
    display: inline-flex; align-items: baseline; gap: 4px;
    color: var(--fg);
  }
  .tri-strip-n {
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-weight: 700; font-size: 16px; color: var(--fg-hi);
  }
  .tri-strip-item.tri-fresh .tri-strip-n { color: var(--accent) }
  .tri-strip-item.tri-old .tri-strip-n { color: var(--muted) }
  .tri-strip-item.tri-noop .tri-strip-n { color: var(--muted) }
  .tri-strip-item.tri-noop { color: var(--muted); font-style: italic }
  .tri-strip.tri-strip-quiet { border-left-color: var(--muted) }
  .tri-strip-hint { color: var(--muted); font-size: 12px }

  /* Freshness group — the plain-English "when did this land" bins */
  .fresh-group { margin: 22px 0 }
  .fresh-head {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    margin: 0 0 14px;
    padding-bottom: 8px; border-bottom: 1px solid var(--line);
  }
  .fresh-title {
    font-size: 20px; font-weight: 600; color: var(--fg-hi);
    margin: 0; letter-spacing: -0.01em;
    text-wrap: balance;
  }
  .fresh-count {
    color: var(--fg); font-family: var(--font-mono);
    font-variant-numeric: tabular-nums; font-size: 11px;
    background: var(--pill); padding: 3px 9px; border-radius: 100px;
  }
  .fresh-hint {
    color: var(--muted); font-size: 12px; font-style: italic;
    margin-left: auto;
  }
  .fresh-body { display: flex; flex-direction: column; gap: 14px }
  /* The "Older" section starts collapsed - <details> inside .fresh-older */
  .fresh-older > details > summary {
    cursor: pointer; list-style: none; user-select: none;
    padding: 8px 12px; background: var(--pill); border: 1px solid var(--line);
    border-radius: 8px;
  }
  .fresh-older > details > summary::-webkit-details-marker { display: none }
  .fresh-older > details > summary::before {
    content: "▸ show ";  color: var(--muted); font-family: var(--font-mono);
    font-size: 10px; margin-right: 6px;
    text-transform: uppercase; letter-spacing: 0.10em;
  }
  .fresh-older > details[open] > summary::before {
    content: "▾ hide ";
  }
  .fresh-older > details > summary .fresh-head {
    border-bottom: none; padding-bottom: 0; margin-bottom: 0;
    display: inline-flex;
  }
  .fresh-older > details > summary .fresh-title { font-size: 15px; font-weight: 500 }
  .fresh-older .fresh-body { padding-top: 14px }

  /* THE TRIAGE CARD - the primary PR surface in v7 */
  .tri-card {
    background: var(--card); border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: 12px;
    padding: 18px 20px;
    display: flex; flex-direction: column; gap: 12px;
  }
  .tri-card.tri-stale { border-left-color: var(--muted); opacity: 0.9 }
  .tri-head {
    display: flex; align-items: center; gap: 10px 14px;
    flex-wrap: wrap; row-gap: 6px;
  }
  .tri-head-l { display: flex; align-items: baseline; gap: 8px 12px; flex-wrap: wrap; min-width: 0 }
  .tri-head-r { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto }
  .tri-num {
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-weight: 700; color: var(--fg-hi); font-size: 15px;
    text-decoration: none;
  }
  .tri-num:hover { color: var(--accent) }
  .tri-ticket {
    font-family: var(--font-mono); font-size: 12px;
    color: var(--muted); text-decoration: none;
  }
  .tri-ticket:hover { color: var(--accent) }
  .tri-ticket-orphan { opacity: 0.55; font-style: italic }
  .tri-when {
    color: var(--fg); font-size: 13px; font-weight: 500;
  }
  .tri-abs {
    color: var(--muted); font-family: var(--font-mono);
    font-size: 10.5px; font-variant-numeric: tabular-nums;
  }
  .flag-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 9px; border-radius: 100px;
    font-family: var(--font-mono); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.10em;
    background: var(--pill); border: 1px solid var(--line);
    color: var(--muted); font-weight: 600; white-space: nowrap;
  }
  .flag-shift-day { color: var(--fg); }
  .flag-shift-night { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)) }
  .flag-dup { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border-color: color-mix(in srgb, var(--warn) 30%, var(--line)) }
  .flag-stale { color: var(--muted) }
  .flag-status.flag-clean { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--line)); background: color-mix(in srgb, var(--success) 10%, var(--pill)) }
  .flag-status.flag-human { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); background: color-mix(in srgb, var(--danger) 12%, var(--pill)) }
  .flag-status.flag-draft { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); background: color-mix(in srgb, var(--warn) 8%, var(--pill)) }
  .flag-status.flag-conflict { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)) }

  .tri-plain {
    font-size: 17px; font-weight: 600; line-height: 1.35;
    color: var(--fg-hi); margin: 4px 0 0;
    letter-spacing: -0.005em; text-wrap: balance;
  }
  .tri-eng {
    color: var(--muted); font-size: 12px; margin: 0;
    font-family: var(--font-mono); line-height: 1.5;
  }
  .tri-eng-open {
    color: var(--accent); text-decoration: none; margin-left: 6px;
    font-family: var(--font-body);
  }
  .tri-eng-open:hover { text-decoration: underline }

  /* Check-this-before-approving list */
  .tri-check {
    background: var(--pill); border: 1px solid var(--line);
    border-radius: 8px; padding: 12px 14px;
  }
  .tri-check-hd {
    font-family: var(--font-mono); font-size: 10.5px;
    text-transform: uppercase; letter-spacing: 0.10em;
    color: var(--muted); font-weight: 600; margin-bottom: 8px;
  }
  .chk-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 6px;
  }
  .chk-item {
    display: flex; align-items: baseline; gap: 8px;
    font-size: 13px; line-height: 1.45; color: var(--fg);
  }
  .chk-box {
    flex: 0 0 auto; margin: 0;
    width: 15px; height: 15px;
    accent-color: var(--accent);
    cursor: pointer;
    position: relative; top: 2px;
  }
  .chk-lbl { cursor: pointer; flex: 1 1 auto }
  .chk-item input:checked + .chk-lbl {
    color: var(--muted); text-decoration: line-through;
  }

  /* Test-in-browser CTA pair - the primary affordance on each card */
  .tb-cta {
    display: flex; align-items: center; gap: 8px 12px;
    flex-wrap: wrap;
    padding: 12px 14px;
    background: color-mix(in srgb, var(--accent) 6%, var(--card));
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
    border-radius: 8px;
  }
  .tb-cta.tb-none {
    background: color-mix(in srgb, var(--muted) 6%, var(--card));
    border-color: var(--line);
    color: var(--muted); font-style: italic; font-size: 13px;
    padding: 10px 14px;
  }
  .tb-cta .tb-url {
    font-family: var(--font-mono); font-size: 11px;
    color: var(--muted); word-break: break-all;
  }
  .tb-cta .tb-hint {
    color: var(--fg); font-size: 12px;
  }
  .tb-cta .tb-prereq {
    width: 100%; margin-top: 4px;
    color: var(--warn); font-size: 11px; font-style: italic;
  }

  /* Buttons — used by test-in-browser CTAs + action forms */
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 100px;
    font-size: 13px; font-weight: 600;
    text-decoration: none; cursor: pointer;
    border: 1px solid transparent;
    font-family: var(--font-body);
    line-height: 1.2;
    white-space: nowrap;
  }
  .btn-primary {
    background: var(--accent); color: #06181A;
    border-color: var(--accent);
  }
  .btn-primary:hover { background: var(--accent-dim); border-color: var(--accent-dim); color: #FFFFFF }
  :root[data-theme="light"] .btn-primary { color: #FFFFFF }
  .btn-secondary {
    background: var(--card); color: var(--fg);
    border-color: var(--line-hi);
  }
  .btn-secondary:hover { background: var(--card-hi); border-color: var(--accent); color: var(--fg-hi) }
  .btn-submit { margin-top: 8px }
  .btn-disabled {
    opacity: 0.4; cursor: not-allowed; pointer-events: none;
    background: var(--pill); color: var(--muted); border-color: var(--line);
  }

  /* Action-form strip: approve / reject / snooze */
  .actions {
    display: flex; align-items: flex-start; gap: 8px;
    flex-wrap: wrap;
    padding: 4px 0;
  }
  .actions-hint {
    color: var(--muted); font-size: 11px; font-style: italic;
    align-self: center;
  }
  .actions-disabled { opacity: 0.85 }
  details.action-form {
    display: inline-block;
  }
  details.action-form > summary {
    list-style: none; cursor: pointer; user-select: none;
  }
  details.action-form > summary::-webkit-details-marker { display: none }
  details.action-form[open] > summary { border-color: var(--accent); background: var(--card-hi) }
  .action-form-body {
    margin-top: 10px;
    padding: 14px;
    background: var(--card-hi); border: 1px solid var(--line-hi);
    border-radius: 8px;
    display: flex; flex-direction: column; gap: 8px;
    max-width: 420px;
  }
  .action-hint {
    color: var(--fg); font-size: 12px; margin: 0;
    line-height: 1.5;
  }
  .action-hint code {
    background: var(--pill); padding: 1px 6px; border-radius: 4px;
    color: var(--fg-hi); font-family: var(--font-mono); font-size: 11px;
  }
  .action-input {
    padding: 8px 12px; border-radius: 6px;
    background: var(--bg); border: 1px solid var(--line-hi);
    color: var(--fg-hi); font-family: var(--font-mono); font-size: 13px;
    letter-spacing: 0.08em;
  }
  .action-input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .action-input:invalid { border-color: var(--danger) }
  .action-note {
    padding: 8px 12px; border-radius: 6px;
    background: var(--bg); border: 1px solid var(--line);
    color: var(--fg); font-family: var(--font-body); font-size: 12px;
    resize: vertical; min-height: 60px;
  }
  .action-note:focus {
    outline: none; border-color: var(--accent);
  }

  /* Continue-in-Claude-Code panel */
  .continue-panel {
    background: var(--pill); border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 13px;
  }
  .continue-panel > summary {
    padding: 8px 14px; cursor: pointer;
    color: var(--fg); font-weight: 500;
    list-style: none; user-select: none;
    display: flex; align-items: center; gap: 8px;
  }
  .continue-panel > summary::-webkit-details-marker { display: none }
  .continue-panel > summary::before {
    content: "▸"; color: var(--muted); font-size: 10px;
    font-family: var(--font-mono);
  }
  .continue-panel[open] > summary::before {
    content: "▾"; color: var(--accent);
  }
  .continue-body { padding: 4px 14px 14px }
  .continue-hint { color: var(--muted); font-size: 11px; margin: 0 0 8px }
  .continue-body .recipe {
    background: var(--bg); border: 1px solid var(--line-hi); border-radius: 4px;
    padding: 10px 12px; margin: 0; overflow-x: auto;
    font-family: var(--font-mono); font-size: 11.5px; line-height: 1.55;
    color: var(--fg); user-select: all; white-space: pre;
  }
  .continue-link { margin-top: 10px; font-size: 12px }
  .continue-link a {
    color: var(--accent); text-decoration: none; font-weight: 500;
    font-family: var(--font-mono);
  }
  .continue-link a:hover { text-decoration: underline }
  /* Rendered when the branch name failed the safe-name check - the
     recipe is suppressed entirely, this warning takes its place. */
  .continue-warning {
    background: color-mix(in srgb, var(--warn) 8%, var(--card));
    border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
    border-left: 3px solid var(--warn); border-radius: 6px;
    padding: 10px 12px; margin: 0;
    color: var(--fg); font-size: 12px; line-height: 1.5;
  }
  .continue-warning code {
    background: var(--pill); padding: 1px 6px; border-radius: 3px;
    font-family: var(--font-mono); font-size: 11px;
  }

  /* Superseded attempts on the same ticket - muted footer inside card */
  .tri-supers {
    padding-top: 10px; margin-top: 4px;
    border-top: 1px dashed var(--line-hi);
    display: flex; flex-direction: column; gap: 4px;
    font-size: 11px; color: var(--muted);
    font-family: var(--font-mono);
  }
  .tri-supers-label {
    text-transform: uppercase; letter-spacing: 0.10em;
    font-weight: 600; color: var(--warn);
  }
  .tri-super-link {
    color: var(--muted); text-decoration: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tri-super-link:hover { color: var(--accent) }

  /* No-op deprioritization footer */
  .noop-section {
    margin: 24px 0 12px;
    padding: 12px 16px;
    background: color-mix(in srgb, var(--muted) 6%, var(--card));
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .noop-summary {
    list-style: none; cursor: pointer; user-select: none;
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    color: var(--muted); font-size: 13px;
  }
  .noop-summary::-webkit-details-marker { display: none }
  .noop-summary::before {
    content: "▸"; color: var(--muted); font-size: 10px;
    font-family: var(--font-mono);
  }
  .noop-section > details[open] > .noop-summary::before {
    content: "▾"; color: var(--accent);
  }
  .noop-icon { color: var(--success); font-weight: 700 }
  .noop-count {
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    color: var(--fg);
  }
  .noop-hint { font-style: italic; font-size: 12px }
  .noop-body {
    margin-top: 10px;
    display: flex; flex-direction: column; gap: 4px;
    font-family: var(--font-mono); font-size: 11.5px;
  }
  .noop-row {
    display: grid;
    grid-template-columns: 60px 60px 1fr auto auto;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 4px;
    align-items: center;
    color: var(--muted);
  }
  .noop-row:hover { background: var(--pill); color: var(--fg) }
  .noop-num { color: var(--muted-hi); text-decoration: none; font-weight: 600 }
  .noop-num:hover { color: var(--accent) }
  .noop-shift {
    text-transform: uppercase; letter-spacing: 0.10em;
    font-size: 10px; color: var(--muted);
  }
  .noop-title {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--fg); font-family: var(--font-body); font-size: 12.5px;
  }
  .noop-when { font-size: 10.5px }
  .noop-flag {
    color: var(--muted); text-decoration: none;
    font-size: 10.5px; padding: 2px 8px; border-radius: 100px;
    border: 1px solid var(--line);
  }
  .noop-flag:hover { color: var(--warn); border-color: var(--warn) }

  /* pill-warn used on the repo header when the token is read-only */
  .pill-warn {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
    background: color-mix(in srgb, var(--warn) 10%, var(--pill));
  }

  /* Mobile: cards go full-bleed, action forms stack full width */
  @media (max-width: 720px) {
    .tri-card { padding: 14px 14px; border-radius: 10px }
    .tri-plain { font-size: 16px }
    .tri-head-r { margin-left: 0; width: 100% }
    .tb-cta { flex-direction: column; align-items: stretch }
    .tb-cta .btn { width: 100% }
    .action-form-body { max-width: 100% }
    .actions { flex-direction: column; align-items: stretch }
    details.action-form { width: 100% }
    details.action-form > summary { display: block; width: 100% }
    .fresh-hint { display: none }
    .noop-row { grid-template-columns: 1fr auto }
    .noop-row .noop-shift, .noop-row .noop-when { display: none }
  }
</style>
</head>
<body>
<div class="app-shell">
  ${renderSidebar(repos, { theme, requestUrl })}
  <div class="main-outer" id="top">

    ${renderTabNav(repos)}

    <h1>Shift dashboard</h1>
    <div class="sub">
      ${repos.length} project${repos.length === 1 ? '' : 's'} · updated ${fmtRel(d.now, d.now)} · auto-refresh 30s
    </div>

    ${renderFlashBanner(flash)}

    <div class="main-grid">
      <main>
        ${repos.map((r) => renderTriageRepoSection(r, d.now, { key })).join('')}
      </main>
      ${renderRail(repos, d.now)}
    </div>

    <footer>shift-dashboard · read-only · rendered at ${new Date(d.now).toUTCString()}</footer>
  </div>
</div>
</body>
</html>`;
}

/**
 * Render one project's block: repo header + per-shift PR lists +
 * merged-to-holding cards + dispatch history.
 *
 * `isFirstRepo` controls whether this repo's sections get the global tab
 * anchors (#ready, #open, #history). Only the FIRST repo gets them so IDs
 * stay unique across the page - the tab bar then anchor-jumps to the first
 * repo's sections, which is the pragmatic default for the common single-
 * repo user and the fastest-to-typical-target for the multi-repo case.
 */
function renderRepoSection(r, now, isFirstRepo = false) {
  const dayPrsArr = Array.isArray(r.dayPrs) ? r.dayPrs : [];
  const nightPrsArr = Array.isArray(r.nightPrs) ? r.nightPrs : [];
  const nightRunsArr = Array.isArray(r.nightRuns) ? r.nightRuns : [];
  const dayRunsArr = Array.isArray(r.dayRuns) ? r.dayRuns : [];
  const dayCount = r.dayPrs?.error ? '?' : dayPrsArr.length;
  const nightCount = r.nightPrs?.error ? '?' : nightPrsArr.length;
  const dayMergedArr = Array.isArray(r.dayMerged) ? r.dayMerged : [];
  const nightMergedArr = Array.isArray(r.nightMerged) ? r.nightMerged : [];
  const nightLast = nightRunsArr[0];
  const dayLast = dayRunsArr[0];
  // Short label for section subtitles: "your-repo" from "your-org/your-repo",
  // "your-second-repo" from "your-org/your-second-repo". Falls back to the repo name.
  const shortLabel = String(r.repo).split('/').pop().replace(/[_-]/g, ' ').toLowerCase();

  // Unified open-PRs section: day + night in one dense table, ticket-grouped
  // + supersede-collapsed + stale-dimmed. Solves the "scroll and scroll" +
  // "night-shift did work I've already done" pains in one view.
  const openPrs = [
    ...dayPrsArr.map((p) => ({ ...p, _shift: 'day' })),
    ...nightPrsArr.map((p) => ({ ...p, _shift: 'night' })),
  ];
  const openGroups = groupByTicket(openPrs, { now });
  const openAttn = openPrs.filter((p) => (p.labels || []).some((l) => /needs-human$/i.test(l))).length;
  const openStale = openGroups.filter((g) => g.isStale).length;
  const openDup = openGroups.filter((g) => g.isDup).length;
  const totalOpen = openPrs.length;
  const openErr = r.dayPrs?.error || r.nightPrs?.error;

  const openCountsHtml = [
    `<span class="c-item">${totalOpen} open</span>`,
    openAttn > 0 ? `<span class="c-item blocker">${openAttn} blocker${openAttn === 1 ? '' : 's'}</span>` : '',
    openDup > 0 ? `<span class="c-item hot">${openDup} dup ticket${openDup === 1 ? '' : 's'}</span>` : '',
    openStale > 0 ? `<span class="c-item dim">${openStale} stale</span>` : '',
  ].filter(Boolean).join('');

  return `
<div class="repo">
  <div class="repo-hd">
    <a href="https://github.com/${escape(r.repo)}" target="_blank">${escape(r.repo)}</a>
    <span class="repo-counts">
      <span class="pill">${dayCount} day · ${nightCount} night</span>
    </span>
  </div>

  <section>
    <h2>Last dispatch · ${escape(shortLabel)}</h2>
    <div class="runs">
      ${sectionOrWarn(r.nightRuns, 'Actions:Read scope', () =>
        renderRunSummary('night-shift', nightLast, now) +
        (dayLast ? renderRunSummary('day-shift', dayLast, now) : ''),
      )}
    </div>
  </section>

  <section${isFirstRepo ? ' id="open"' : ''}>
    <div class="section-hd">
      <div class="section-hd-l">
        <span class="eyebrow"><span class="dot dot-accent" style="background: var(--accent)"></span>Open pull requests</span>
        <h3>Ready for your review</h3>
      </div>
      <div class="counts">${openCountsHtml}</div>
    </div>
    ${openErr ? sectionOrWarn(r.dayPrs?.error ? r.dayPrs : r.nightPrs, 'Pull requests:Read scope', () => '')
      : totalOpen === 0 ? '<div class="empty">Nothing open.</div>'
      : renderPrTable(openGroups, now)}
  </section>

  ${dayMergedArr.length + nightMergedArr.length > 0 || r.dayMerged?.error || r.nightMerged?.error ? `
  <section${isFirstRepo ? ' id="ready"' : ''}>
    <div class="section-hd">
      <div class="section-hd-l">
        <span class="eyebrow"><span class="dot dot-success" style="background: var(--success)"></span>Ready to test or promote</span>
        <h3>Merged to holding &middot; last 48h</h3>
      </div>
      <div class="counts">
        <span class="c-item">${dayMergedArr.length + nightMergedArr.length} merged</span>
      </div>
    </div>
    ${sectionOrWarn(r.dayMerged, 'Pull requests:Read scope', () =>
      dayMergedArr.map((p) => renderMergedPr(p, 'day', now)).join(''),
    )}
    ${sectionOrWarn(r.nightMerged, 'Pull requests:Read scope', () =>
      nightMergedArr.map((p) => renderMergedPr(p, 'night', now)).join(''),
    )}
  </section>
  ` : ''}

  <section${isFirstRepo ? ' id="history"' : ''}>
    <div class="section-hd">
      <div class="section-hd-l">
        <span class="eyebrow"><span class="dot dot-muted" style="background: var(--muted)"></span>Dispatch history</span>
        <h3>Recent night-shift runs</h3>
      </div>
    </div>
    <div class="runs">
      ${sectionOrWarn(r.nightRuns, 'Actions:Read scope', () =>
        nightRunsArr.map((rr) => renderRunRow(rr, now)).join('') || '<div class="empty">No runs yet.</div>',
      )}
    </div>
  </section>
</div>`;
}

/**
 * The slim state-strip that replaces the 4-KPI grid. Loop-toned mono row
 * with role-colored numbers: OPEN (fg), BLOCKERS (red), DUPS (amber),
 * READY (green), STALE (amber). Pain #3 (density) - the KPIs were
 * redundant with the sidebar counts; the strip trades panels for numbers
 * that actually change decisions.
 */
function renderStateStrip(repos) {
  const open = safeSum(repos, 'dayPrs') + safeSum(repos, 'nightPrs');
  const ready = safeSum(repos, 'dayMerged') + safeSum(repos, 'nightMerged');
  const allOpen = [
    ...collectAcrossRepos(repos, 'dayPrs'),
    ...collectAcrossRepos(repos, 'nightPrs'),
  ];
  const attn = allOpen.filter((p) => (p.labels || []).some((l) => /needs-human$/i.test(l))).length;
  const groups = groupByTicket(allOpen);
  const dups = groups.filter((g) => g.isDup).length;
  const stale = groups.filter((g) => g.isStale).length;
  const items = [
    { cls: '', n: open, l: 'open' },
    { cls: 'attn', n: attn, l: 'blockers' },
    { cls: '', n: dups, l: 'dup tickets' },
    { cls: 'ready', n: ready, l: 'ready to promote' },
    { cls: 'stale', n: stale, l: 'stale (>5d)' },
  ];
  return `<div class="state-strip">
    ${items.map((it, i) => `
      ${i > 0 ? '<span class="st-sep"></span>' : ''}
      <span class="st ${it.cls}"><span class="st-n">${it.n}</span><span class="st-l">${escape(it.l)}</span></span>
    `).join('')}
  </div>`;
}

/**
 * Render the ticket-grouped PR table. One <details> per group. Summary is
 * the visible row (grid: caret, #num, ticket, shift, title, files/delta,
 * status, when). Body expands to show brain, test-in-browser link, and any
 * superseded attempts.
 *
 * Sort: primary groups arrive already sorted by groupByTicket (fresh first,
 * stale last, newest-updated within bucket).
 */
function renderPrTable(groups, now) {
  const head = `<div class="pr-thead">
    <span></span>
    <span>#</span>
    <span>Ticket</span>
    <span>Shift</span>
    <span>Title</span>
    <span class="th-r">Files &middot; +/-</span>
    <span class="th-r">Status</span>
    <span class="th-r">Updated</span>
  </div>`;
  const rows = groups.map((g) => renderPrRow(g, now)).join('');
  return `<div class="pr-table">${head}${rows}</div>`;
}

/**
 * One row of the PR table. `g` is a { primary, superseded, isStale, isDup,
 * ticketId } group from groupByTicket. Summary line shows the primary;
 * body includes brain, test-in-browser, and (if any) a compact list of the
 * older superseded attempts on the same ticket.
 */
function renderPrRow(g, now) {
  const pr = g.primary;
  const shift = pr._shift || 'day';
  const statusInfo = prStatusInfo(pr);
  const delta = renderPrDeltaCell(pr);
  const shortRepo = pr._repo ? String(pr._repo).split('/').pop() : '';
  const cleanLabel = (pr.labels || []).find((l) => /:(?:claude-)?reviewed-clean$/i.test(l));

  // Title cell: title + optional DUP / STALE flag pill in the same cell.
  const flags = [];
  if (g.isDup) flags.push(`<span class="flag dup" title="${g.superseded.length} older attempt${g.superseded.length === 1 ? '' : 's'} on ticket #${g.ticketId}">DUP · ${g.superseded.length + 1}</span>`);
  if (g.isStale) flags.push(`<span class="flag stale" title="No update for &gt;5 days">STALE</span>`);
  const titleCell = `<div class="pr-title-cell">
    <span class="t">${escape(pr.title)}</span>
    ${flags.join('')}
  </div>`;

  const ticketCell = g.ticketId
    ? `<span class="pr-ticket"><a href="https://github.com/${escape((pr._repo || '').split('/').slice(0,2).join('/') || 'your-org/your-repo')}/issues/${g.ticketId}" target="_blank">#${g.ticketId}</a></span>`
    : `<span class="pr-ticket pr-ticket-orphan">-</span>`;

  // Body: brain row + test-browser link + superseded list.
  const supers = g.superseded.length > 0
    ? `<div class="super-list">
        <div class="super-title">Superseded attempts on ticket ${g.ticketId ? '#' + g.ticketId : ''}</div>
        ${g.superseded.map((sp) => `<div class="super-item">
          <a href="${escape(sp.url)}" target="_blank"><span class="n">#${sp.number}</span></a>
          <span class="t">${escape(sp.title)}</span>
          <span class="when">${escape(sp._shift || '')} &middot; ${fmtRel(sp.updatedAt, now)}</span>
        </div>`).join('')}
      </div>`
    : '';

  const bodyRow = `<div class="pr-body-row">
    <a href="${escape(pr.url)}" target="_blank">Open on GitHub &rarr;</a>
    ${pr.base ? `<span>base: <code>${escape(pr.base)}</code></span>` : ''}
    ${pr.mergeable_state && pr.mergeable_state !== 'clean' && pr.mergeable_state !== 'unknown' ? `<span style="color:var(--danger)">mergeable: ${escape(pr.mergeable_state)}</span>` : ''}
    ${cleanLabel ? `<span style="color:var(--success)">${escape(cleanLabel)}</span>` : ''}
  </div>`;

  const rowCls = ['pr'];
  if (g.isStale) rowCls.push('stale');

  return `<details class="${rowCls.join(' ')}">
    <summary>
      <span class="pr-caret">&#9656;</span>
      <span class="pr-num">#${pr.number}</span>
      ${ticketCell}
      <span class="pr-shift ${shift === 'night' ? 'night' : ''}">${escape(shift)}</span>
      ${titleCell}
      <span class="pr-delta">${delta}</span>
      <span class="pr-status ${statusInfo.cls}">${escape(statusInfo.text)}</span>
      <span class="pr-when">${fmtRel(pr.updatedAt, now)}</span>
    </summary>
    <div class="pr-body">
      ${bodyRow}
      ${renderBrainRow(pr.brain)}
      ${renderTestBrowserLink(pr.testRoute)}
      ${supers}
    </div>
  </details>`;
}

/**
 * Compute the status pill for a PR row. Priority (highest wins):
 *   needs-human > merge conflict > reviewed-clean > draft > default (ready)
 * Kept semantic - a conflict is more urgent than a clean review because the
 * reviewer literally cannot merge until it's resolved.
 */
function prStatusInfo(pr) {
  const labels = pr.labels || [];
  if (labels.some((l) => /needs-human$/i.test(l))) return { cls: 'human', text: '● human' };
  if (pr.mergeable_state === 'dirty' || pr.mergeable_state === 'blocked') return { cls: 'conflict', text: '● conflict' };
  if (labels.some((l) => /:(?:claude-)?reviewed-clean$/i.test(l))) return { cls: 'clean', text: '● clean' };
  if (pr.isDraft) return { cls: 'draft', text: '● draft' };
  return { cls: '', text: '● ready' };
}

/**
 * The "files touched · +additions/-deletions" cell. Color-coded by total
 * delta magnitude so the eye lands on "this is a big change, spend more
 * review time." Falls back gracefully when enrichment failed (nulls) - the
 * cell renders "-" so the row layout stays aligned.
 *
 * Thresholds: <100 lines = normal · 100-500 = amber · >500 = red.
 * These match the typical "am I about to nod this through without reading
 * it" mental threshold.
 */
function renderPrDeltaCell(pr) {
  const files = pr.changed_files;
  const add = pr.additions;
  const del = pr.deletions;
  if (files == null && add == null && del == null) {
    return `<span class="empty">-</span>`;
  }
  const total = (add || 0) + (del || 0);
  let totalCls = 'delta-total';
  if (total >= 500) totalCls += ' huge';
  else if (total >= 100) totalCls += ' big';
  const filesHtml = files != null ? `<span class="files">${files}f</span>` : '';
  const plusHtml = add != null ? ` <span class="plus">+${add}</span>` : '';
  const minusHtml = del != null ? `<span class="minus">-${del}</span>` : '';
  return `${filesHtml} <span class="${totalCls}">${plusHtml}${plusHtml && minusHtml ? '/' : ''}${minusHtml}</span>`;
}

/**
 * If `field` is a { error } shape, render a compact inline warning naming
 * the most likely missing scope so the user knows what to add to the PAT.
 * If `field` is fine (an array), just call `okRenderer()` for the normal
 * output. This is what lets one section fail without erroring the page.
 */
function sectionOrWarn(field, likelyScope, okRenderer) {
  if (field && field.error) {
    return `<div class="warn">
      <strong>Section unavailable.</strong>
      Most likely cause: the fine-grained PAT is missing <code>${escape(likelyScope)}</code> on this repo.
      Add it at <a href="https://github.com/settings/personal-access-tokens" target="_blank">github.com/settings/personal-access-tokens</a>, then reload.
      <details><summary>Details</summary><pre>${escape(field.error)}</pre></details>
    </div>`;
  }
  return okRenderer();
}

/**
 * Sum a per-repo field across all repos, treating error shapes as 0.
 * Used by the Next-actions strip aggregate counts.
 */
function safeSum(repos, key) {
  return repos.reduce((n, r) => n + (Array.isArray(r[key]) ? r[key].length : 0), 0);
}

/**
 * Flatten a per-repo field's arrays into one cross-repo array, tagging
 * each entry with its `repo` + `shift` for downstream rendering. Errored
 * fields are skipped (rendering falls back to just showing what's fetchable).
 *
 * The `shift` tag matches how renderPr / renderMergedPr expect the value
 * ("day" / "night") - inferred from the key.
 */
function collectAcrossRepos(repos, key) {
  const shift = key.startsWith('night') ? 'night' : 'day';
  const out = [];
  for (const r of repos) {
    if (!Array.isArray(r[key])) continue;
    for (const pr of r[key]) {
      out.push({ ...pr, _repo: r.repo, _shift: shift });
    }
  }
  return out;
}

/**
 * "Attention Needed" panel. Aggregates PRs labeled `needs-human` (either
 * shift's variant) across all repos into a single callout with the Loop
 * reference's red-left-border treatment. Empty when nothing needs
 * attention - hides the panel entirely.
 */
/**
 * "Shift schedule" panel. Answers "when does each shift fire?" - the
 * question that today required reading the workflow YAML on github.
 *
 * Data sources:
 * - Night-shift: cron from the workflow file (fetched at edge, cached 30s).
 * - Day-shift: fixed "every 30 min while Mac awake" - the LaunchAgent
 *   interval isn't fetchable from github; the dashboard's baseline
 *   assumption matches the com.example.day-shift.plist StartInterval=1800.
 * - Last-fire timestamps: from existing ghListRuns data (dayRuns/nightRuns).
 *
 * Renders 2 rows: NIGHT + DAY. Each shows humanized schedule + next fire
 * + last dispatch outcome. Rendered in the right rail above Attention -
 * "when is the next thing?" is the fastest-scan question on the page.
 */
function renderAttentionPanel(repos, now) {
  const all = [
    ...collectAcrossRepos(repos, 'dayPrs'),
    ...collectAcrossRepos(repos, 'nightPrs'),
  ];
  const attn = all.filter((p) =>
    (p.labels || []).some((l) => /needs-human$/i.test(l)),
  );
  if (attn.length === 0) return '';
  const items = attn.slice(0, 8).map((p) => {
    const shortRepo = String(p._repo).split('/').pop();
    return `<a class="attn-item" href="${escape(p.url)}" target="_blank">
      <div class="attn-title">
        <span class="attn-num">#${p.number}</span>
        <span class="attn-repo">${escape(shortRepo)}</span>
      </div>
      <div class="attn-desc">${escape(p.title)}</div>
    </a>`;
  }).join('');
  const overflow = attn.length > 8
    ? `<div class="attn-more">+${attn.length - 8} more</div>`
    : '';
  return `<section class="panel panel-attention" id="attention">
    <div class="panel-hd">
      <h2>◇ Attention Needed</h2>
      <span class="panel-count">${attn.length}</span>
    </div>
    <div class="attn-list">${items}${overflow}</div>
  </section>`;
}

/**
 * "Real-time Stream" panel. Aggregates dispatch runs across all repos +
 * both shifts, sorts newest-first, renders as a terminal-styled feed
 * (mono, status dot, timestamp). Matches the Loop reference's
 * "Agent Activity" panel.
 */
function renderStreamPanel(repos, now) {
  const runs = [
    ...collectAcrossRepos(repos, 'dayRuns'),
    ...collectAcrossRepos(repos, 'nightRuns'),
  ]
    .filter((r) => r && r.createdAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);
  if (runs.length === 0) {
    return `<section class="panel panel-stream">
      <div class="panel-hd">
        <h2>◇ Real-time Stream</h2>
        <span class="panel-status">● idle</span>
      </div>
      <div class="stream-list"><div class="empty">No dispatch activity yet.</div></div>
    </section>`;
  }
  const activeRun = runs.find((r) => r.status !== 'completed');
  const statusPill = activeRun
    ? `<span class="panel-status live">● live</span>`
    : `<span class="panel-status">● idle</span>`;
  const items = runs.map((run) => {
    const { color, statusText } = runStatus(run);
    const shortRepo = String(run._repo).split('/').pop();
    const shiftTag = run._shift;
    return `<div class="stream-row">
      <span class="stream-dot" style="background: ${color}; color: ${color}"></span>
      <span class="stream-shift">${escape(shiftTag)}</span>
      <span class="stream-msg">
        <a href="${escape(run.url)}" target="_blank">#${run.runNumber || '?'}</a>
        <span class="stream-repo">@ ${escape(shortRepo)}</span>
        <span class="stream-arrow">→</span>
        <span class="stream-status">${escape(statusText)}</span>
      </span>
      <span class="stream-when">${fmtRel(run.createdAt, now)}</span>
    </div>`;
  }).join('');
  return `<section class="panel panel-stream">
    <div class="panel-hd">
      <h2>◇ Real-time Stream</h2>
      ${statusPill}
    </div>
    <div class="stream-list">${items}</div>
  </section>`;
}

/**
 * The right rail. Two stacked panels (Attention + Stream). Rendered next
 * to the main content in the 2-column layout; collapses under it on
 * narrow viewports (see .main-grid @media in CSS).
 */
function renderRail(repos, now) {
  return `<aside class="rail">
    ${renderSchedulePanel(repos, now)}
    ${renderAttentionPanel(repos, now)}
    ${renderStreamPanel(repos, now)}
  </aside>`;
}

/**
 * Left sidebar navigation. Mirrors the Loop reference's shape:
 * - Logo top ("SHIFTS" - the dashboard's identity)
 * - "WORKSPACE" section eyebrow
 * - Anchor-nav items (each jumps to a page section) with live count badges
 * - Placeholder items for future pages (dimmed, no href)
 * - User identity pill at bottom
 *
 * The sidebar is sticky-full-height on wide screens; hidden below 960px
 * where the top tab-nav takes over.
 *
 * Anchor targets align with the tab-nav (#ready, #open, #history) plus
 * #attention (new, added on the attention panel in the right rail).
 */
function renderSidebar(repos, opts = {}) {
  const open = safeSum(repos, 'dayPrs') + safeSum(repos, 'nightPrs');
  const ready = safeSum(repos, 'dayMerged') + safeSum(repos, 'nightMerged');
  const attn = (
    collectAcrossRepos(repos, 'dayPrs').concat(collectAcrossRepos(repos, 'nightPrs'))
  ).filter((p) => (p.labels || []).some((l) => /needs-human$/i.test(l))).length;

  // Inline SVG icons - small (16px), stroke-based, current-color so they
  // pick up the nav item's text color. Bundled here so no external asset
  // fetches (CSP-safe).
  const iconDash = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>`;
  const iconReady = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 6.5 11.5 13 4.5"/></svg>`;
  const iconOpen = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M2 8h12M2 12h9"/></svg>`;
  const iconAttn = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v6M8 12v.5"/><circle cx="8" cy="8" r="6.5"/></svg>`;
  const iconHist = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l2.5 1.5"/></svg>`;
  const iconAgents = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="10" height="8" rx="1.5"/><path d="M8 3v2M6 8h.01M10 8h.01"/></svg>`;
  const iconDeploy = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l4 4v6l-4 2-4-2V6z"/><path d="M8 8l4-2M8 8l-4-2M8 8v6"/></svg>`;
  const iconSettings = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M15 8h-2M3 8H1M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4M12.5 12.5l-1.4-1.4M4.9 4.9L3.5 3.5"/></svg>`;

  const item = (href, icon, label, count, extra = '') =>
    `<a class="side-item${extra}" href="${href}">
      <span class="side-icon">${icon}</span>
      <span class="side-label">${escape(label)}</span>
      ${count !== null ? `<span class="side-count">${count}</span>` : ''}
    </a>`;

  const disabledItem = (icon, label) =>
    `<span class="side-item side-item-disabled" title="Coming soon">
      <span class="side-icon">${icon}</span>
      <span class="side-label">${escape(label)}</span>
      <span class="side-count side-count-soon">soon</span>
    </span>`;

  // On mobile the sidebar collapses to a single-row disclosure — a compact
  // brand + hamburger bar at the top that expands into the full nav when
  // tapped. On desktop the disclosure is force-shown via CSS so the sidebar
  // reads as always-open. The <details> element gives us that toggle with
  // zero JavaScript (matches the page's `default-src 'none'` CSP).
  return `<aside class="sidebar" aria-label="Dashboard navigation">
    <details class="sidebar-collapse">
      <summary class="sidebar-summary" aria-label="Toggle navigation">
        <span class="sidebar-summary-brand">
          <span class="side-logo">SHIFTS</span>
          <span class="side-logo-dot"></span>
        </span>
        <span class="sidebar-summary-hamburger" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
        </span>
      </summary>
      <div class="sidebar-content">
        <div class="side-brand">
          <span class="side-logo">SHIFTS</span>
          <span class="side-logo-dot"></span>
        </div>

        <div class="side-section">
          <div class="side-eyebrow">Workspace</div>
          ${item('#top', iconDash, 'Dashboard', null, ' side-item-active')}
          ${item('#ready', iconReady, 'Ready', ready)}
          ${item('#open', iconOpen, 'Open PRs', open)}
          ${item('#attention', iconAttn, 'Attention', attn)}
          ${item('#history', iconHist, 'History', null)}
        </div>

        <div class="side-section">
          <div class="side-eyebrow">Coming soon</div>
          ${disabledItem(iconAgents, 'Agents')}
          ${disabledItem(iconDeploy, 'Deployments')}
          ${disabledItem(iconSettings, 'Settings')}
        </div>

        <div class="side-spacer"></div>

        ${renderThemeToggle(opts.theme || 'auto', opts.requestUrl || null)}

        <div class="side-user">
          <span class="side-avatar">OP</span>
          <span class="side-user-meta">
            <span class="side-user-name">operator</span>
            <span class="side-user-status"><span class="dot dot-success"></span> active</span>
          </span>
        </div>
      </div>
    </details>
  </aside>`;
}

/**
 * Sticky top tab bar. Three anchor links that jump to the first repo's
 * matching section. Not full-filter tabs (that would require restructuring
 * the DOM around slice-groups instead of repo-groups) - but for the common
 * case ("I merged something, take me straight to it"), a one-tap jump is
 * the right ergonomic. Sticky so it stays available while scrolling.
 *
 * Counts come from the same aggregates the Next-actions strip uses.
 */
function renderTabNav(repos) {
  const open = safeSum(repos, 'dayPrs') + safeSum(repos, 'nightPrs');
  const ready = safeSum(repos, 'dayMerged') + safeSum(repos, 'nightMerged');
  // Each tab: colored dot + label + count. Ready tab first so it visually
  // leads the eye to the section the user most commonly wants to reach
  // quickly. Dots use Loop's semantic accents: success=merged, accent=open,
  // muted=history (no active state).
  return `<nav class="tab-nav" aria-label="Jump to section">
    <a href="#ready" class="tab"><span class="dot dot-success"></span>Ready to test / promote <span class="tab-count">(${ready})</span></a>
    <a href="#open" class="tab"><span class="dot dot-accent"></span>Open PRs <span class="tab-count">(${open})</span></a>
    <a href="#history" class="tab"><span class="dot dot-muted"></span>History</a>
  </nav>`;
}

/**
 * The one-line "next actions" strip at the top of the page. Product goal:
 * the reviewer sees the state of the world BEFORE scrolling, and knows
 * whether there's anything to do.
 *
 * Deliberately generic - counts across all repos, no project-specific words.
 * Portable to any repo the dashboard is pointed at.
 */
function renderNextActionsStrip(repos) {
  const open = safeSum(repos, 'dayPrs') + safeSum(repos, 'nightPrs');
  const ready = safeSum(repos, 'dayMerged') + safeSum(repos, 'nightMerged');
  if (open === 0 && ready === 0) {
    return `<div class="next-actions"><span class="na-quiet">Nothing awaiting you right now.</span></div>`;
  }
  const parts = [];
  if (open > 0) {
    parts.push(`<span class="na-num">${open}</span> awaiting your review`);
  }
  if (ready > 0) {
    parts.push(`<span class="na-num">${ready}</span> ready to test locally or promote`);
  }
  return `<div class="next-actions"><strong>Next:</strong> ${parts.join(' &middot; ')}</div>`;
}

/**
 * MERGED-to-holding PR card. Distinct from an OPEN PR card:
 * - Solid "merged to holding" pill
 * - Green left-border accent so the eye lands on it as "state changed"
 * - Two collapsed action panels: test locally + promote to Staging
 *
 * Uses `<details>` for collapsibility - no JS needed, CSP stays clean.
 */
function renderMergedPr(pr, shift, now) {
  return `
    <div class="card merged">
      <div class="row1">
        <span class="num">#${pr.number}</span>
        <span class="pill merged">● merged to holding</span>
        <span class="pill">${escape(shift)}</span>
        <a class="title" href="${escape(pr.url)}" target="_blank">${escape(pr.title)}</a>
      </div>
      <div class="sub" style="margin-top:6px">merged ${fmtRel(pr.mergedAt, now)} into <code>${escape(pr.base)}</code></div>
      ${renderBrainRow(pr.brain)}
      ${renderTestBrowserLink(pr.testRoute)}
      <div class="action-panels">
        ${renderTestLocallyPanel(pr)}
        ${renderPromoteRecipe(pr)}
      </div>
    </div>`;
}

/**
 * "Test locally" foldable panel. Recipe is generic - it uses the PR's own
 * holding branch (`pr.base`) so it works for any repo the dashboard serves,
 * not just the source project. The user's local checkout path is intentionally NOT
 * hardcoded; the reviewer knows their own dev tree.
 *
 * CSS `user-select: all` on the <pre> lets one click select the whole
 * recipe for copy-paste. No JS = CSP stays `default-src 'none'`.
 */
function renderTestLocallyPanel(pr) {
  const recipe =
`# In your local clone of the repo:
git fetch origin ${pr.base}
git checkout ${pr.base}
# Then start your project's dev server (e.g. \`npm run localhost\` for the source project)`;
  return `
    <details class="action">
      <summary>Test locally</summary>
      <div class="body">
        <p class="hint">Click the box to select all, then copy. Fast-forward pulls the merged code onto your machine.</p>
        <pre class="recipe">${escape(recipe)}</pre>
        <div class="link-row">
          Then open <a href="http://localhost:8080" target="_blank">http://localhost:8080</a>
          <span style="color:var(--muted);"> (default; some projects use a different port)</span>
        </div>
      </div>
    </details>`;
}

/**
 * "Promote holding to Staging" foldable panel. Recipe is a fast-forward
 * merge from the holding branch into Staging, matching the day-shift flow
 * (holding is always ff-only ahead of Staging when a run finishes cleanly).
 *
 * Generic across projects - only uses `pr.base` for the holding branch name.
 */
function renderPromoteRecipe(pr) {
  const recipe =
`# From a Staging-tracking clone of the repo:
git fetch origin Staging ${pr.base}
git checkout Staging
git pull --ff-only
git merge --no-ff origin/${pr.base} -m "promote ${pr.base} -> Staging"
git push origin Staging`;
  return `
    <details class="action">
      <summary>Promote holding to Staging</summary>
      <div class="body">
        <p class="hint">Only after you have tested + are satisfied. Merging the holding branch into Staging triggers the Staging deploy.</p>
        <pre class="recipe">${escape(recipe)}</pre>
      </div>
    </details>`;
}

// The v3 `renderPr` (card-per-PR) was removed in the v4 UX rework - the open
// PR list is now `renderPrTable` (dense ticket-grouped expandable rows).
// See the "PR-list pattern (v4)" section in the design skill.

/**
 * Compact one-line brain summary rendered inside a PR card. Renders nothing
 * when the PR was opened before brain wiring landed (Staging < ce77060f) or
 * when day-shift ran without the flag - so old PRs stay clean.
 *
 * Layout: `🧠 3 attempts · last: STUCK (25m) · 2 hints · ESCALATED`
 * The escalated pill flips red so a bounced ticket jumps off the page.
 */
function renderBrainRow(brain) {
  if (!brain) return '';
  const parts = [];
  if (brain.attempts > 0) {
    parts.push(`${brain.attempts} attempt${brain.attempts === 1 ? '' : 's'}`);
  } else {
    parts.push('first attempt');
  }
  if (brain.lastOutcome) {
    const dur = brain.lastDurationSec ? ` (${fmtDur(brain.lastDurationSec)})` : '';
    parts.push(`last: <span class="brain-outcome brain-outcome-${escape(brain.lastOutcome.toLowerCase())}">${escape(brain.lastOutcome)}</span>${dur}`);
  }
  if (brain.hints > 0) {
    parts.push(`${brain.hints} hint${brain.hints === 1 ? '' : 's'}`);
  }
  const escalatedPill = brain.escalated
    ? ' <span class="pill human" style="margin-left:4px">⛔ escalated</span>'
    : '';
  return `<div class="brain-row">🧠 ${parts.join(' · ')}${escalatedPill}</div>`;
}

function fmtDur(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}

function renderRunSummary(label, run, now) {
  if (!run) {
    return `<div class="run-row"><span class="dot" style="background: var(--muted)"></span>
      <span>${escape(label)}</span>
      <span class="when">no runs yet</span>
    </div>`;
  }
  const { color, statusText } = runStatus(run);
  return `<div class="run-row">
    <span class="dot" style="background: ${color}"></span>
    <a href="${escape(run.url)}" target="_blank">${escape(label)} · ${statusText}</a>
    <span class="when">${fmtRel(run.createdAt, now)}</span>
  </div>`;
}

function renderRunRow(run, now) {
  const { color, statusText } = runStatus(run);
  return `<div class="run-row">
    <span class="dot" style="background: ${color}"></span>
    <a href="${escape(run.url)}" target="_blank">#${run.runNumber} ${escape(run.event)} · ${statusText}</a>
    <span class="when">${fmtRel(run.createdAt, now)}</span>
  </div>`;
}

function runStatus(run) {
  if (run.status !== 'completed') return { color: 'var(--run)', statusText: run.status };
  if (run.conclusion === 'success') return { color: 'var(--ok)', statusText: 'passed' };
  if (run.conclusion === 'failure') return { color: 'var(--fail)', statusText: 'failed' };
  return { color: 'var(--muted)', statusText: run.conclusion || 'done' };
}

/**
 * Time label: relative + absolute together, e.g. "3m ago · Jul 25 18:23 UTC".
 * Relative is skim-friendly ("was it just now?"); absolute is auditable
 * ("was that dispatch before or after I merged X?").
 */
function fmtRel(then, now) {
  const t = new Date(then).getTime();
  const n = new Date(now).getTime();
  const s = Math.max(0, Math.round((n - t) / 1000));
  let rel;
  if (s < 60) rel = s + 's ago';
  else if (s < 3600) rel = Math.round(s / 60) + 'm ago';
  else if (s < 86400) rel = Math.round(s / 3600) + 'h ago';
  else if (s < 7 * 86400) rel = Math.round(s / 86400) + 'd ago';
  else rel = new Date(then).toISOString().slice(0, 10);
  return `${rel} · ${fmtAbs(then)}`;
}

/** Absolute UTC time, phone-readable: "Jul 25 18:23 UTC". */
function fmtAbs(then) {
  const d = new Date(then);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function escape(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderError(err) {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard error</title>
<style>body{font:14px -apple-system,sans-serif;padding:16px;max-width:640px;margin:auto;color:#b42318}pre{background:#f7f8fb;padding:12px;border-radius:8px;white-space:pre-wrap;color:#101828}</style>
<h2>Dashboard error</h2>
<pre>${escape(err.stack || err.message || String(err))}</pre>
<p>Reload to retry, or check the Worker logs: <code>wrangler tail</code>.</p>`;
}

// ═════════════════════════════════════════════════════════════════════════
// v7 - 5th-grader triage view (added 2026-08-04)
// ═════════════════════════════════════════════════════════════════════════
//
// The dense v4 table lost the 15-min triage flow because:
//   1. All PRs looked the same age (no "since you were last here" break)
//   2. Titles were engineer-code (`fix(auth):`) with no plain-English gloss
//   3. The reviewer had no "check this before approving" list
//   4. Test-in-browser was buried in a <details> foldout
//   5. Approve/reject were "go open GitHub" chores
//   6. No-op PRs (empty diff, work already staged) sat next to real work
//   7. Continue-in-Claude-Code recipe wasn't on every card
//
// v7 rewrites the primary PR surface as a stack of large triage cards
// grouped by freshness bucket. Ticket-grouping (v4) still runs underneath
// so DUP attempts collapse; the primary IS the triage card. The old
// pr-table/renderPrRow/renderPrTable helpers stay exported for tests but
// are no longer wired into the main render path.
//
// Design contract: see .claude/skills/shift-dashboard-design/SKILL.md v7.
// ═════════════════════════════════════════════════════════════════════════

/**
 * Bin PRs by how long ago they were updated. Pure function - takes an array
 * of PRs (post-ticket-grouping is fine; each entry can be a group's primary
 * or a raw PR), returns `{ fresh, yesterday, thisWeek, older }` in ordered
 * newest-first arrays.
 *
 * Bucket boundaries (matches the brief):
 *   fresh:     updated < 14h  ago  ("Since you were last here")
 *   yesterday: updated 14–38h ago  ("Yesterday")
 *   thisWeek:  updated 2–7d   ago  ("Earlier this week")
 *   older:     updated > 7d   ago  ("Older" - collapsed by default)
 *
 * `now` accepted as an ISO string so tests can pin it. Missing/invalid
 * `updatedAt` → treated as `Infinity` old → falls into `older`.
 */
function groupPrsByFreshness(prs, opts = {}) {
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const H = 3600e3;
  const D = 24 * H;
  const buckets = { fresh: [], yesterday: [], thisWeek: [], older: [] };
  for (const p of Array.isArray(prs) ? prs : []) {
    const t = p && p.updatedAt ? new Date(p.updatedAt).getTime() : NaN;
    const ageMs = Number.isFinite(t) ? now - t : Infinity;
    if (ageMs < 14 * H) buckets.fresh.push(p);
    else if (ageMs < 38 * H) buckets.yesterday.push(p);
    else if (ageMs < 7 * D) buckets.thisWeek.push(p);
    else buckets.older.push(p);
  }
  // newest first inside each bucket
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }
  return buckets;
}

/**
 * Was this shift-PR a no-op? "No-op" = the shift correctly detected that no
 * code change was needed (e.g. the fix was already on Staging). These render
 * IDENTICALLY to real PRs in v4, wasting reviewer attention. In v7 they
 * collapse to a small "Nothing to do (worked correctly)" footer section.
 *
 * A PR counts as a no-op when ANY of:
 *   - `changed_files === 0` (nothing was diffed)
 *   - `changed_files === 1 && additions === 0 && deletions === 0`
 *   - body contains an explicit "no code changes" / "already on Staging"
 *     marker (the shift's `openDraftPR` can emit one; scan tolerantly)
 *
 * Enrichment-missing (null files/additions/deletions) → we can NOT confirm
 * no-op, so return false (safer to show than to hide silently).
 */
function isNoOpPr(pr) {
  if (!pr) return false;
  const files = pr.changed_files;
  const add = pr.additions;
  const del = pr.deletions;
  if (files === 0) return true;
  if (files === 1 && add === 0 && del === 0) return true;
  const body = String(pr.body || '');
  if (/no code changes|nothing to (?:fix|do)|already (?:on|in) staging|no diff/i.test(body)) return true;
  return false;
}

/**
 * Turn an engineer-code commit title into a plain-English one-liner a
 * junior dev can read. Applied to the PR title:
 *   "fix(auth): remember last used login method"
 *     → "Fix (auth): Remember last used login method"
 *   "feat(business): calendar keyboard shortcuts"
 *     → "New feature (business): Calendar keyboard shortcuts"
 *
 * Rules:
 *   - Split off leading `<type>(<scope>):` or `<type>:`. Map <type> to a
 *     junior-friendly noun. Preserve scope in parens so the reviewer still
 *     sees which subsystem was touched (that's context, not jargon).
 *   - Capitalize the first letter of what's left. Strip a trailing (#1234)
 *     ticket ref - it's redundant with the ticket link on the card.
 *   - Unknown type / no colon → return the title verbatim with its first
 *     letter capitalized. Never fabricate a translation.
 */
function renderPlainEnglishSummary(pr) {
  const raw = String(pr && pr.title || '').trim();
  if (!raw) return '';
  // Strip trailing "(#1234)" ticket suffix — we render the ticket separately.
  let t = raw.replace(/\s*\(#\d{2,6}\)\s*$/, '').trim();
  const m = t.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
  if (!m) return capFirst(t);
  const type = m[1].toLowerCase();
  const scope = m[2] ? ` (${m[2]})` : '';
  const rest = capFirst(m[3].trim());
  const nounMap = {
    fix: 'Fix',
    bug: 'Bug fix',
    feat: 'New feature',
    feature: 'New feature',
    chore: 'Housekeeping',
    refactor: 'Code cleanup',
    docs: 'Docs update',
    doc: 'Docs update',
    test: 'Tests',
    tests: 'Tests',
    perf: 'Speed improvement',
    style: 'Style tidy-up',
    ci: 'CI/build change',
    build: 'Build change',
    revert: 'Revert',
    hotfix: 'Urgent fix',
  };
  const noun = nounMap[type];
  if (!noun) return capFirst(raw.replace(/\s*\(#\d{2,6}\)\s*$/, ''));
  return `${noun}${scope}: ${rest}`;
}
function capFirst(s) {
  const str = String(s || '');
  return str.length ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

/**
 * Scan a text blob (PR body or a comment) for a Codex Cloud session URL.
 * The chatgpt-codex-connector app comments with links shaped like
 * `https://chatgpt.com/codex/tasks/task_<hex>` or `.../sessions/<id>`.
 * Returns the first match, or null. Pure — no fetches.
 *
 * We keep the match permissive on the trailing path (tasks OR sessions) so
 * both current + old comment shapes work.
 */
function parseCodexSessionUrl(text) {
  const m = String(text || '').match(/https:\/\/chatgpt\.com\/codex\/(?:tasks|sessions)\/[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

/**
 * Build the "check this before approving" list for a PR. Returns an array
 * of `{ id, text }` items (no HTML). Layered by:
 *   - The PR's declared test-route (highest-value; test the exact change).
 *   - The PR body's own "Reviewer checklist" - if the shift already wrote
 *     one, we surface a compact hint pointing at it (not a re-emit).
 *   - File heuristics: UI files → click through; backend → skim + tests;
 *     test-only → no app-testing needed.
 *   - Label heuristics: `bug` → reproduce; `feat`/`enhancement` → try end-to-end.
 *   - Always: "Read the plain-English summary" + "Check for out-of-scope changes".
 */
function buildChecklist(pr, group = {}) {
  const items = [];
  const files = [];
  const add = (id, text) => items.push({ id, text });

  add('read-summary', 'Read the plain-English summary above.');

  if (pr.testRoute && pr.testRoute.path) {
    const openHint = pr.testRoute.open ? ` (${pr.testRoute.open})` : '';
    add('open-test-route', `Open the test URL below and do the change${openHint}.`);
  }

  // Ticket-type hints
  const labels = (pr.labels || []).map((l) => String(l).toLowerCase());
  if (labels.some((l) => l === 'bug' || l.endsWith(':bug') || /bug/.test(l))) {
    add('reproduce-bug', 'Reproduce the original bug and confirm it is now gone.');
  }
  if (labels.some((l) => /^feat|enhancement/.test(l))) {
    add('try-feature', 'Try the new feature end-to-end - not just the happy path.');
  }

  // File heuristics — best-effort using the PR body's file list, else fall
  // back to conventional-commit `type`. We don't fetch files here (cost).
  const type = (String(pr.title || '').match(/^(\w+)[(:]/) || [])[1] || '';
  if (/(component|ui|frontend|design|button|modal|form|page)/i.test(pr.title || '')) {
    add('click-through-ui', 'Click through the affected page(s). Watch the mobile width too.');
  } else if (/test/i.test(type) || (pr.changed_files && pr.additions + pr.deletions > 0 && /\.spec\.|\.test\./.test(pr.title || ''))) {
    add('tests-only', 'No app-testing needed - this is a test-coverage change.');
  } else if (/(server|api|route|backend|db|sql|migration)/i.test(pr.title || '')) {
    add('backend-skim', 'Skim the diff. Ship if CI is green and the change matches the summary.');
  }

  // Big-diff guard
  const total = (pr.additions || 0) + (pr.deletions || 0);
  if (total >= 500) {
    add('big-diff', 'This is a large change (500+ lines). Read the diff more carefully than usual.');
  } else if (total >= 100) {
    add('medium-diff', 'Medium-size change - spot-check the diff, don\'t nod it through.');
  }

  // Merge conflict
  if (pr.mergeable_state === 'dirty' || pr.mergeable_state === 'blocked') {
    add('resolve-conflict', 'Merge conflict - resolve locally before approving.');
  }

  add('out-of-scope', 'Confirm nothing out-of-scope was touched (rogue file / stray refactor / secrets).');

  // Ticket dup / stale nuance
  if (group.isDup) {
    add('dup-warn', `The same ticket had ${group.superseded.length} earlier attempt(s). Confirm this one supersedes them.`);
  }
  if (group.isStale) {
    add('stale-warn', 'This PR has been sitting for more than 5 days - re-check the base branch is still up to date.');
  }
  return items;
}

/**
 * Render the checklist as a native `<ul>` of `<input type="checkbox">`
 * items. No JS — the checkboxes are transient (state resets on refresh),
 * but they give the reviewer a physical "tick as you go" affordance that
 * plain bullets don't. `namePrefix` lets multiple cards on the page have
 * unique input ids.
 */
function renderCheckList(items, namePrefix) {
  if (!items || !items.length) return '';
  const rows = items.map((it, i) => {
    const id = `chk-${escape(namePrefix)}-${escape(it.id)}-${i}`;
    return `<li class="chk-item">
      <input type="checkbox" id="${id}" class="chk-box">
      <label for="${id}" class="chk-lbl">${escape(it.text)}</label>
    </li>`;
  }).join('');
  return `<ul class="chk-list">${rows}</ul>`;
}

/**
 * Big primary "Test in browser" CTA + "Open in new tab" pair for a triage
 * card. Falls back to a muted "No browser test - code-only change" note
 * when the shift did not declare a TEST_ROUTE. That negative signal is
 * itself useful: it tells the reviewer they don't need to spin up localhost.
 */
function renderTestBrowserCtas(pr) {
  if (!pr.testRoute) {
    return `<div class="tb-cta tb-none">No browser test declared - code-only change (skim the diff).</div>`;
  }
  const url = `http://localhost:${pr.testRoute.port}${pr.testRoute.path}`;
  const openHint = pr.testRoute.open
    ? `<span class="tb-hint">${escape(pr.testRoute.open)}</span>`
    : '';
  const prereqHint = pr.testRoute.hint
    ? `<div class="tb-prereq">${escape(pr.testRoute.hint)}</div>`
    : '';
  return `<div class="tb-cta">
    <a class="btn btn-primary" href="${escape(url)}" target="_blank" rel="noopener noreferrer">🌐 Test in browser</a>
    <a class="btn btn-secondary" href="${escape(url)}" target="_blank" rel="noopener noreferrer">Open in new tab</a>
    <span class="tb-url">${escape(url)}</span>
    ${openHint}
    ${prereqHint}
  </div>`;
}

/**
 * Approve / Reject / Snooze forms for a triage card. Each is a native POST
 * form gated by a required text input the reviewer must type (`APPROVE` /
 * `REJECT` / `SNOOZE`) — a stray tap never fires an action.
 *
 * When the token lacks write scope (`permissions.push !== true`), the whole
 * strip renders disabled with the token-widen tooltip. The rest of the
 * dashboard stays fully functional; only mutations gate.
 */
function renderActionForms(pr, opts) {
  const key = opts && opts.key || '';
  const repo = opts && opts.repo || '';
  const permissions = opts && opts.permissions || null;
  const canWrite = permissions && permissions.push === true;

  // Common query string carried into every action POST.
  const qs = `pr=${encodeURIComponent(pr.number)}&repo=${encodeURIComponent(repo)}&key=${encodeURIComponent(key)}`;

  if (!canWrite) {
    const reason = !permissions
      ? 'The token could not be probed for this repo.'
      : 'GH_TOKEN is read-only.';
    return `<div class="actions actions-disabled" title="${escape(reason)} Approve/Reject/Snooze disabled - update the token to include Contents:write + Issues:write. Run: npx wrangler secret put GH_TOKEN and paste a wider-scoped token.">
      <span class="btn btn-primary btn-disabled">✅ Approve &amp; merge</span>
      <span class="btn btn-secondary btn-disabled">❌ Reject</span>
      <span class="btn btn-secondary btn-disabled">↷ Snooze</span>
      <span class="actions-hint">token read-only - see README</span>
    </div>`;
  }

  return `<div class="actions">
    <details class="action-form action-approve">
      <summary class="btn btn-primary">✅ Approve &amp; merge</summary>
      <form method="POST" action="/action/approve?${qs}" class="action-form-body">
        <p class="action-hint">Squash-merges PR #${escape(pr.number)} into <code>${escape(pr.base || '')}</code>. Type <code>APPROVE</code> to confirm:</p>
        <input class="action-input" name="confirm" required pattern="APPROVE" placeholder="APPROVE" autocomplete="off" spellcheck="false">
        <button type="submit" class="btn btn-primary btn-submit">Confirm merge</button>
      </form>
    </details>
    <details class="action-form action-reject">
      <summary class="btn btn-secondary">❌ Reject</summary>
      <form method="POST" action="/action/reject?${qs}" class="action-form-body">
        <p class="action-hint">Labels the PR <code>needs-human</code> and posts an audit comment. Type <code>REJECT</code> to confirm:</p>
        <input class="action-input" name="confirm" required pattern="REJECT" placeholder="REJECT" autocomplete="off" spellcheck="false">
        <textarea class="action-note" name="note" placeholder="Why reject? (optional, becomes a PR comment)" maxlength="500"></textarea>
        <button type="submit" class="btn btn-secondary btn-submit">Confirm reject</button>
      </form>
    </details>
    <details class="action-form action-snooze">
      <summary class="btn btn-secondary">↷ Snooze</summary>
      <form method="POST" action="/action/snooze?${qs}" class="action-form-body">
        <p class="action-hint">Labels the PR <code>snoozed-until-tomorrow</code> - dashboard hides it for 24h. Type <code>SNOOZE</code>:</p>
        <input class="action-input" name="confirm" required pattern="SNOOZE" placeholder="SNOOZE" autocomplete="off" spellcheck="false">
        <button type="submit" class="btn btn-secondary btn-submit">Confirm snooze</button>
      </form>
    </details>
  </div>`;
}

/**
 * "Continue this in Claude Code" panel + Codex Cloud session link (if any).
 * Recipe is `user-select: all` so a single click grabs it for paste. The
 * codex link comes from parseCodexSessionUrl(pr.body) — we don't fetch
 * comments (too expensive per PR). If the shift didn't leave the link in
 * the PR body itself, the link is hidden.
 */
/**
 * Strict git-ref allowlist. Rejects anything that isn't a valid GitHub
 * branch name (letters, digits, `_ . - /`). Used to gate interpolation
 * into shell recipe text so a maliciously-named branch cannot smuggle
 * metacharacters into the reviewer's terminal on copy-paste.
 *
 * GitHub already rejects most metacharacters at branch-creation, but
 * defense-in-depth: if a compromised token or an unexpected upstream
 * ever produced a weird ref, we render a disabled recipe rather than
 * a live injection surface.
 */
function isSafeBranchName(s) {
  return typeof s === 'string' && /^[A-Za-z0-9._\-\/]+$/.test(s) && s.length <= 250;
}

function renderContinuePanel(pr, opts) {
  const shortRepo = String((opts && opts.repo) || '').split('/').pop() || 'repo';
  const branch = String(pr.base || '');
  const codexUrl = parseCodexSessionUrl(pr.body || '');

  // SECURITY: never interpolate the PR title into the shell recipe. Titles
  // are attacker-controllable (anyone who can open an issue can influence
  // the eventual PR title). Backticks / $(...) / ; / && / | inside a title
  // would execute on the reviewer's Mac at copy-paste time. Instead:
  //   - Recipe is a fixed 2-line git command with a whitelisted branch.
  //   - The "prompt for Claude" lives in its OWN separate copy-block, so
  //     it never touches a shell; the user pastes it INTO Claude Code's
  //     prompt after the CLI is already running.
  // See the accompanying test in __tests__/continuePanelSafety.test.mjs.
  const safeBranch = isSafeBranchName(branch);
  const gitRecipe = safeBranch
    ? `git fetch origin ${branch}\ngit checkout ${branch}\nclaude`
    : null;
  // Primer is raw text the user will paste INTO Claude's prompt after
  // starting the CLI. Since it never runs through a shell, HTML-escape is
  // the only sanitization it needs. Titles / numbers stay verbatim so the
  // primer is useful; the reviewer's eyes are the final gate before
  // pasting.
  const primer = `Continue work on ${shortRepo} PR #${pr.number}: ${(pr.title || '').slice(0, 200)}. Read the PR body and the review comments, then implement the requested fixes. Do not push or open a new PR - the reviewer will handle merge.`;

  return `<details class="continue-panel">
    <summary>Continue in Claude Code / Codex</summary>
    <div class="continue-body">
      ${gitRecipe
        ? `<p class="continue-hint">1. Copy + paste this in your terminal to check out the branch and start Claude Code:</p>
           <pre class="recipe">${escape(gitRecipe)}</pre>
           <p class="continue-hint" style="margin-top:10px">2. Once Claude is running, paste this as your first prompt:</p>
           <pre class="recipe">${escape(primer)}</pre>`
        : `<p class="continue-warning">Branch name failed the safe-name check (contains characters that could smuggle shell commands into your terminal on copy-paste). Recipe suppressed. Open the PR on github to see the branch name safely.</p>`
      }
      ${codexUrl ? `<div class="continue-link"><a href="${escape(codexUrl)}" target="_blank" rel="noopener noreferrer">Open the Codex Cloud session &rarr;</a></div>` : ''}
    </div>
  </details>`;
}

/**
 * Render one triage card - the primary PR surface in v7. `group` is a
 * ticket-group from groupByTicket; `pr` is the group's primary. `opts`
 * carries the key, repo, and probed permissions for the mutation forms.
 *
 * The card layout, top-to-bottom:
 *   1. Header strip: #NNNN · ticket · shift pill · relative time · flags
 *   2. Plain-English summary (BIG, primary text)
 *   3. Engineer title (small, muted - the original for auditability)
 *   4. Check-this-before-approving list (native checkboxes)
 *   5. Test-in-browser CTA pair (primary buttons)
 *   6. Approve / Reject / Snooze forms
 *   7. Continue-in-Claude-Code recipe + Codex session link
 *   8. Superseded attempts on the same ticket (if any) - muted footer
 */
function renderTriageCard(group, opts) {
  const pr = group.primary;
  const shift = pr._shift || 'day';
  const repo = pr._repo || (opts && opts.repo) || '';
  const shortRepo = String(repo).split('/').pop();
  const now = (opts && opts.now) || new Date().toISOString();

  const plain = renderPlainEnglishSummary(pr);
  const engTitle = String(pr.title || '').replace(/\s*\(#\d{2,6}\)\s*$/, '');
  const items = buildChecklist(pr, group);
  const namePrefix = `${shortRepo}-${pr.number}`;

  const flags = [];
  if (group.isDup) flags.push(`<span class="flag-pill flag-dup" title="${group.superseded.length} older attempt(s) on ticket #${group.ticketId}">DUP · ${group.superseded.length + 1}</span>`);
  if (group.isStale) flags.push(`<span class="flag-pill flag-stale">STALE &gt;5d</span>`);
  const statusInfo = prStatusInfo(pr);
  const statusPill = `<span class="flag-pill flag-status flag-${statusInfo.cls}">${escape(statusInfo.text)}</span>`;
  flags.push(statusPill);

  const shiftPill = `<span class="flag-pill flag-shift flag-shift-${escape(shift)}">${escape(shift)}-shift</span>`;
  const ticketBit = group.ticketId
    ? `<a class="tri-ticket" href="https://github.com/${escape(repo)}/issues/${group.ticketId}" target="_blank" rel="noopener noreferrer">ticket #${group.ticketId}</a>`
    : `<span class="tri-ticket tri-ticket-orphan">no linked ticket</span>`;

  const supers = group.superseded && group.superseded.length
    ? `<div class="tri-supers">
        <span class="tri-supers-label">Also on this ticket (older attempts):</span>
        ${group.superseded.map((sp) => `<a class="tri-super-link" href="${escape(sp.url)}" target="_blank" rel="noopener noreferrer">#${sp.number} ${escape((sp.title || '').slice(0, 90))}</a>`).join('')}
      </div>`
    : '';

  return `<article class="tri-card ${group.isStale ? 'tri-stale' : ''}">
    <header class="tri-head">
      <div class="tri-head-l">
        <a class="tri-num" href="${escape(pr.url)}" target="_blank" rel="noopener noreferrer">#${pr.number}</a>
        ${ticketBit}
        ${shiftPill}
        <span class="tri-when">${escape(fmtRel(pr.updatedAt, now).split(' · ')[0])}</span>
        <span class="tri-abs" title="${escape(fmtAbs(pr.updatedAt))}">${escape(fmtAbs(pr.updatedAt))}</span>
      </div>
      <div class="tri-head-r">${flags.join('')}</div>
    </header>

    <h4 class="tri-plain">${escape(plain)}</h4>
    <p class="tri-eng">${escape(engTitle)} <a class="tri-eng-open" href="${escape(pr.url)}" target="_blank" rel="noopener noreferrer">open on GitHub &rarr;</a></p>

    <section class="tri-check">
      <div class="tri-check-hd">Check this before approving:</div>
      ${renderCheckList(items, namePrefix)}
    </section>

    ${renderTestBrowserCtas(pr)}

    ${renderActionForms(pr, { key: opts && opts.key, repo, permissions: opts && opts.permissions })}

    ${renderContinuePanel(pr, { repo })}

    ${supers}
  </article>`;
}

/**
 * Render one freshness bucket (fresh / yesterday / thisWeek / older). Each
 * bucket has a plain-English heading and a stacked list of triage cards.
 * The `older` bucket is wrapped in a collapsed <details> by default so
 * ancient work doesn't dominate the page.
 */
function renderFreshnessGroup(bucketKey, groups, opts) {
  if (!groups || !groups.length) return '';
  const meta = FRESHNESS_BUCKET_META[bucketKey] || FRESHNESS_BUCKET_META.older;
  const cards = groups.map((g) => renderTriageCard(g, opts)).join('');
  const heading = `<div class="fresh-head">
    <h3 class="fresh-title">${meta.icon} ${escape(meta.label)}</h3>
    <span class="fresh-count">${groups.length} PR${groups.length === 1 ? '' : 's'}</span>
    <span class="fresh-hint">${escape(meta.hint)}</span>
  </div>`;
  if (meta.collapsedByDefault) {
    return `<section class="fresh-group fresh-${escape(bucketKey)}">
      <details>
        <summary class="fresh-summary">${heading}</summary>
        <div class="fresh-body">${cards}</div>
      </details>
    </section>`;
  }
  return `<section class="fresh-group fresh-${escape(bucketKey)}">
    ${heading}
    <div class="fresh-body">${cards}</div>
  </section>`;
}
const FRESHNESS_BUCKET_META = {
  fresh:     { icon: '🌅', label: 'Since you were last here',           hint: 'landed in the last 14 hours',   collapsedByDefault: false },
  yesterday: { icon: '📅', label: 'Yesterday',                          hint: '14 to 38 hours ago',           collapsedByDefault: false },
  thisWeek:  { icon: '📆', label: 'Earlier this week',                  hint: '2 to 7 days ago',              collapsedByDefault: false },
  older:     { icon: '🗄️', label: 'Older',                              hint: 'more than a week old',         collapsedByDefault: true },
};

/**
 * Deprioritized "Nothing to do (worked correctly)" section - shift ran,
 * correctly detected there was nothing to change, opened an empty PR. In
 * v4 this looked identical to a real PR; in v7 it collapses here so the
 * reviewer's eye never lands on it during the 15-min triage. A "Flag this"
 * link on each row lets the reviewer complain if the shift should have
 * classified the ticket differently upstream.
 */
function renderNoOpSection(noOps, opts) {
  if (!noOps || !noOps.length) return '';
  const items = noOps.map((pr) => {
    const shift = pr._shift || 'day';
    const repo = pr._repo || (opts && opts.repo) || '';
    const shortRepo = String(repo).split('/').pop();
    const now = (opts && opts.now) || new Date().toISOString();
    const flagUrl = `${escape(pr.url)}/files`;
    return `<div class="noop-row">
      <a class="noop-num" href="${escape(pr.url)}" target="_blank" rel="noopener noreferrer">#${pr.number}</a>
      <span class="noop-shift">${escape(shift)}</span>
      <span class="noop-title">${escape(pr.title || '')}</span>
      <span class="noop-when">${escape(fmtRel(pr.updatedAt || pr.createdAt || '', now).split(' · ')[0])}</span>
      <a class="noop-flag" href="${flagUrl}" target="_blank" rel="noopener noreferrer" title="Open the empty diff on GitHub to inspect it. If the shift should have skipped this ticket entirely, file an issue.">Flag this</a>
    </div>`;
  }).join('');
  return `<section class="noop-section">
    <details>
      <summary class="noop-summary">
        <span class="noop-icon">✓</span>
        Nothing to do <span class="noop-count">(${noOps.length})</span>
        <span class="noop-hint">- these shifts ran but correctly did nothing (empty PR).</span>
      </summary>
      <div class="noop-body">${items}</div>
    </details>
  </section>`;
}

/**
 * Slim triage strip at the top of the page - answers the ONE question:
 * "how many PRs need my eyes right now?" Replaces the v4 state-strip's
 * six-metric row. Focuses on WHAT NEEDS DOING vs total counts.
 */
function renderTriageStrip(freshness, noOpCount) {
  const freshCount = freshness.fresh.length;
  const dayOldCount = freshness.yesterday.length;
  const weekCount = freshness.thisWeek.length;
  const olderCount = freshness.older.length;
  const total = freshCount + dayOldCount + weekCount + olderCount;
  if (total === 0 && noOpCount === 0) {
    return `<div class="tri-strip tri-strip-quiet">
      <span class="tri-strip-lead">All caught up.</span>
      <span class="tri-strip-hint">The shifts had nothing waiting for you this pass.</span>
    </div>`;
  }
  if (freshCount === 0 && dayOldCount === 0 && weekCount === 0) {
    return `<div class="tri-strip tri-strip-quiet">
      <span class="tri-strip-lead">Nothing new since last time.</span>
      <span class="tri-strip-hint">${olderCount} older item${olderCount === 1 ? '' : 's'} still open below.</span>
    </div>`;
  }
  const parts = [];
  if (freshCount > 0) parts.push(`<span class="tri-strip-item tri-fresh"><span class="tri-strip-n">${freshCount}</span> fresh</span>`);
  if (dayOldCount > 0) parts.push(`<span class="tri-strip-item"><span class="tri-strip-n">${dayOldCount}</span> from yesterday</span>`);
  if (weekCount > 0) parts.push(`<span class="tri-strip-item"><span class="tri-strip-n">${weekCount}</span> earlier this week</span>`);
  if (olderCount > 0) parts.push(`<span class="tri-strip-item tri-old"><span class="tri-strip-n">${olderCount}</span> older (collapsed)</span>`);
  if (noOpCount > 0) parts.push(`<span class="tri-strip-item tri-noop"><span class="tri-strip-n">${noOpCount}</span> nothing-to-do (footer)</span>`);
  return `<div class="tri-strip">
    <strong class="tri-strip-lead">To review:</strong>
    ${parts.join('')}
  </div>`;
}

/**
 * v7 replacement for renderRepoSection. Ticket-grouped, then bucketed by
 * freshness. Cards inside each bucket. No-op PRs pulled out into a
 * collapsed footer section.
 */
function renderTriageRepoSection(r, now, opts) {
  const dayPrsArr = Array.isArray(r.dayPrs) ? r.dayPrs : [];
  const nightPrsArr = Array.isArray(r.nightPrs) ? r.nightPrs : [];
  const openPrs = [
    ...dayPrsArr.map((p) => ({ ...p, _shift: 'day', _repo: r.repo })),
    ...nightPrsArr.map((p) => ({ ...p, _shift: 'night', _repo: r.repo })),
  ];
  const openErr = r.dayPrs?.error || r.nightPrs?.error;
  const groups = groupByTicket(openPrs, { now });

  // Split no-op groups out. A group is a no-op iff its PRIMARY is no-op —
  // superseded attempts are irrelevant (the primary is what shows up front).
  const realGroups = [];
  const noOpPrs = [];
  for (const g of groups) {
    if (isNoOpPr(g.primary)) noOpPrs.push(g.primary);
    else realGroups.push(g);
  }
  const freshness = groupPrsByFreshness(realGroups.map((g) => g.primary), { now });
  // Re-attach the group to each primary so renderTriageCard has the group
  // metadata (isDup, isStale, superseded). Map by pr.number → group.
  const groupByNum = new Map(realGroups.map((g) => [g.primary.number, g]));
  const bucketed = {};
  for (const k of Object.keys(freshness)) {
    bucketed[k] = freshness[k].map((pr) => groupByNum.get(pr.number)).filter(Boolean);
  }

  const permissions = (r.permissions && !r.permissions.error) ? r.permissions : null;
  const cardOpts = { key: opts && opts.key, repo: r.repo, permissions, now };

  const nightRunsArr = Array.isArray(r.nightRuns) ? r.nightRuns : [];
  const dayRunsArr = Array.isArray(r.dayRuns) ? r.dayRuns : [];
  const nightLast = nightRunsArr[0];
  const dayLast = dayRunsArr[0];
  const shortLabel = String(r.repo).split('/').pop().replace(/[_-]/g, ' ').toLowerCase();

  const dayMergedArr = Array.isArray(r.dayMerged) ? r.dayMerged : [];
  const nightMergedArr = Array.isArray(r.nightMerged) ? r.nightMerged : [];

  return `
<div class="repo">
  <div class="repo-hd">
    <a href="https://github.com/${escape(r.repo)}" target="_blank" rel="noopener noreferrer">${escape(r.repo)}</a>
    <span class="repo-counts">
      <span class="pill">${dayPrsArr.length} day &middot; ${nightPrsArr.length} night</span>
      ${permissions && permissions.push ? '' : `<span class="pill pill-warn" title="Approve/Reject/Snooze disabled - token is read-only">read-only token</span>`}
    </span>
  </div>

  ${renderTriageStrip(bucketed, noOpPrs.length)}

  <section id="open">
    ${openErr ? sectionOrWarn(r.dayPrs?.error ? r.dayPrs : r.nightPrs, 'Pull requests:Read scope', () => '')
      : (bucketed.fresh.length + bucketed.yesterday.length + bucketed.thisWeek.length + bucketed.older.length) === 0
        ? '<div class="empty">Nothing to review right now. Enjoy the coffee.</div>'
        : `
        ${renderFreshnessGroup('fresh', bucketed.fresh, cardOpts)}
        ${renderFreshnessGroup('yesterday', bucketed.yesterday, cardOpts)}
        ${renderFreshnessGroup('thisWeek', bucketed.thisWeek, cardOpts)}
        ${renderFreshnessGroup('older', bucketed.older, cardOpts)}
      `}
  </section>

  ${renderNoOpSection(noOpPrs, { repo: r.repo, now })}

  ${dayMergedArr.length + nightMergedArr.length > 0 || r.dayMerged?.error || r.nightMerged?.error ? `
  <section id="ready">
    <div class="section-hd">
      <div class="section-hd-l">
        <span class="eyebrow"><span class="dot dot-success" style="background: var(--success)"></span>Already merged, ready to promote</span>
        <h3>Merged to holding &middot; last 48h</h3>
      </div>
      <div class="counts">
        <span class="c-item">${dayMergedArr.length + nightMergedArr.length} merged</span>
      </div>
    </div>
    ${sectionOrWarn(r.dayMerged, 'Pull requests:Read scope', () =>
      dayMergedArr.map((p) => renderMergedPr(p, 'day', now)).join(''),
    )}
    ${sectionOrWarn(r.nightMerged, 'Pull requests:Read scope', () =>
      nightMergedArr.map((p) => renderMergedPr(p, 'night', now)).join(''),
    )}
  </section>
  ` : ''}

  <section id="history">
    <div class="section-hd">
      <div class="section-hd-l">
        <span class="eyebrow"><span class="dot dot-muted" style="background: var(--muted)"></span>Dispatch history</span>
        <h3>Recent shift runs</h3>
      </div>
    </div>
    <div class="runs">
      ${sectionOrWarn(r.nightRuns, 'Actions:Read scope', () =>
        renderRunSummary('night-shift', nightLast, now) +
        (dayLast ? renderRunSummary('day-shift', dayLast, now) : '') +
        nightRunsArr.slice(0, 5).map((rr) => renderRunRow(rr, now)).join('') || '<div class="empty">No runs yet.</div>',
      )}
    </div>
  </section>
</div>`;
}

/**
 * Flash toast at the top of the page (v7). Rendered ONLY when the browser
 * arrived here carrying a `flash=` cookie set by a POST handler; the fetch
 * handler also emits a Set-Cookie clearing it, so the toast is a strict
 * one-visit affair.
 */
function renderFlashBanner(flash) {
  if (!flash) return '';
  const cls = flash.kind === 'ok' ? 'flash-ok' : 'flash-err';
  const icon = flash.kind === 'ok' ? '✅' : '⚠️';
  return `<div class="flash ${cls}" role="status">
    <span class="flash-icon">${icon}</span>
    <span class="flash-msg">${escape(flash.msg)}</span>
  </div>`;
}


// Named exports so unit tests can import the pure helpers without spinning
// up a Cloudflare Worker sandbox. CF ignores extra named exports at runtime;
// the `default` export above is still the fetch handler.
export {
  parseBrainSnapshot,
  fmtDur,
  safeSum,
  renderHtml,
  renderNextActionsStrip,
  renderTestLocallyPanel,
  renderPromoteRecipe,
  renderMergedPr,
  renderTabNav,
  parseTestRoute,
  renderTestBrowserLink,
  collectAcrossRepos,
  renderAttentionPanel,
  renderStreamPanel,
  renderRail,
  renderSidebar,
  // v4 UX rework (Loop layout - dense ticket-grouped PR table)
  parseTicketId,
  groupByTicket,
  renderPrTable,
  renderPrRow,
  renderPrDeltaCell,
  prStatusInfo,
  renderStateStrip,
  // Shared utils exported so extracted sub-modules (cron.js, theme.js)
  // can import them as live bindings.
  escape,
  fmtRel,
  // v7 5th-grader triage view
  groupPrsByFreshness,
  isNoOpPr,
  renderPlainEnglishSummary,
  parseCodexSessionUrl,
  buildChecklist,
  renderCheckList,
  renderTestBrowserCtas,
  renderActionForms,
  renderContinuePanel,
  isSafeBranchName,
  renderTriageCard,
  renderFreshnessGroup,
  renderNoOpSection,
  renderFlashBanner,
  renderTriageStrip,
  renderTriageRepoSection,
  readFlashCookie,
};
