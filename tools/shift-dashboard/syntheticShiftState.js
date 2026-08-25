/**
 * SYNTHETIC_PRS mode fixture.
 *
 * `SYNTHETIC_PRS=1 wrangler dev` short-circuits every GitHub call and returns
 * this stable, loadShiftState-shaped payload so the OSS repo is runnable end
 * to end without a GH token. Used for local dev, screenshots, and CI-preview
 * builds. All timestamps are computed relative to "now" so screenshots always
 * land in the intended freshness buckets.
 *
 * Extracted from worker.js to keep the orchestrator file small. If you touch
 * the shape here, run `node --test __tests__/synthetic.test.mjs` -- the
 * fixture is tested as if it were the real GitHub response.
 */

export function syntheticShiftState() {
  const now = new Date();
  const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const REPO = 'your-org/example-app';
  const holdingBranch = 'day-shift-staging-2026-08-25';

  const mkPr = (o) => ({
    number: o.number,
    title: o.title,
    url: `https://github.com/${REPO}/pull/${o.number}`,
    labels: o.labels || [],
    isDraft: o.isDraft || false,
    updatedAt: o.updatedAt,
    createdAt: o.createdAt || o.updatedAt,
    base: o.base || holdingBranch,
    body: o.body || `Automated PR from the day shift.\n\nTEST_ROUTE: /${o.slug || 'settings'}\n\nCloses #${o.ticket || o.number}`,
    brain: null,
    testRoute: o.testRoute || `/${o.slug || 'settings'}`,
    ticketId: o.ticket || null,
    additions: o.additions ?? 42,
    deletions: o.deletions ?? 8,
    changed_files: o.changed_files ?? 3,
    mergeable_state: o.mergeable_state || 'clean',
  });

  const dayPrs = [
    mkPr({
      number: 1284, ticket: 1280, updatedAt: iso(0.4 * HOUR),
      title: 'fix(settings): keyboard focus ring appears on click, not just tab (#1280)',
      labels: ['day-shift:reviewed-clean', 'bug'],
      slug: 'settings', additions: 24, deletions: 6, changed_files: 2,
    }),
    mkPr({
      number: 1283, ticket: 1279, updatedAt: iso(2 * HOUR),
      title: 'feat(dashboard): freshness grouping for stale-issue triage (#1279)',
      labels: ['enhancement'],
      slug: 'dashboard', additions: 187, deletions: 42, changed_files: 5,
    }),
    mkPr({
      number: 1282, ticket: 1278, updatedAt: iso(6 * HOUR),
      title: 'chore(deps): bump vite from 5.4.2 to 5.4.6 (#1278)',
      labels: [],
      slug: 'no-ui', additions: 0, deletions: 0, changed_files: 1,
      body: 'no code changes / already on Staging.\n\nCloses #1278',
      testRoute: null,
    }),
    mkPr({
      number: 1281, ticket: 1275, updatedAt: iso(20 * HOUR),
      title: 'fix(auth): session expiry banner blocks the primary CTA on mobile (#1275)',
      labels: ['day-shift:needs-human', 'bug', 'mobile'],
      slug: 'account', additions: 89, deletions: 24, changed_files: 4,
      mergeable_state: 'dirty',
    }),
    mkPr({
      number: 1276, ticket: 1270, updatedAt: iso(3 * DAY),
      title: 'refactor(theme): consolidate duplicate token declarations (#1270)',
      labels: [],
      slug: 'theme', additions: 512, deletions: 480, changed_files: 12,
    }),
    mkPr({
      number: 1240, ticket: 1235, updatedAt: iso(14 * DAY),
      title: 'perf(charts): defer chart.js until user scrolls into view (#1235)',
      labels: [],
      slug: 'reports', additions: 68, deletions: 14, changed_files: 3,
    }),
  ];

  const nightPrs = [
    mkPr({
      number: 1285, ticket: 1281, updatedAt: iso(9 * HOUR),
      title: 'test(dashboard): characterization suite for freshness buckets (#1281)',
      labels: ['night-shift:reviewed-clean', 'tests'],
      slug: 'no-ui', additions: 122, deletions: 0, changed_files: 2,
      base: 'night-shift-staging-2026-08-25',
      testRoute: null,
    }),
    mkPr({
      number: 1279, ticket: 1273, updatedAt: iso(30 * HOUR),
      title: 'docs(readme): document SYNTHETIC_PRS local-dev flow (#1273)',
      labels: ['night-shift:reviewed-clean', 'docs'],
      slug: 'no-ui', additions: 41, deletions: 3, changed_files: 1,
      base: 'night-shift-staging-2026-08-25',
      testRoute: null,
    }),
  ];

  const dayMerged = [
    {
      ...mkPr({
        number: 1273, ticket: 1269, updatedAt: iso(26 * HOUR),
        title: 'fix(sidebar): collapsed rail no longer overlaps main content on 1024px (#1269)',
        labels: ['day-shift:reviewed-clean'],
        slug: 'dashboard', additions: 34, deletions: 12, changed_files: 2,
      }),
      mergedAt: iso(24 * HOUR),
    },
  ];
  const nightMerged = [];

  let runN = 100;
  const dispatchRun = (msAgo, ok = true) => ({
    id: Math.floor(1_000_000 + Math.random() * 9_000_000),
    status: 'completed',
    conclusion: ok ? 'success' : 'failure',
    event: 'schedule',
    branch: 'main',
    url: `https://github.com/${REPO}/actions/runs/synthetic`,
    createdAt: iso(msAgo),
    runNumber: runN++,
  });

  return {
    now: now.toISOString(),
    repos: [{
      repo: REPO,
      dayPrs,
      nightPrs,
      nightRuns: [dispatchRun(9 * HOUR), dispatchRun(33 * HOUR), dispatchRun(57 * HOUR), dispatchRun(81 * HOUR, false), dispatchRun(105 * HOUR)],
      dayRuns:   [dispatchRun(0.4 * HOUR), dispatchRun(0.9 * HOUR), dispatchRun(1.4 * HOUR)],
      dayMerged,
      nightMerged,
      nightCron: '0 23 * * *',
      permissions: { pull: true, push: true, admin: false },
    }],
  };
}
