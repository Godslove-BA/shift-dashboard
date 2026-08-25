# Changelog

The shift-dashboard shipped in five versions across a week and a half.
Each version was driven by a specific pain the previous version created, not by a redesign for its own sake.

The full history of what changed and why is preserved here because it is the portfolio artifact — the design is the iteration, not the endpoint.

---

## v7.1 — Mutation-path hardening (week of 2026-08-04)

**Why this shipped:** v7 added Approve / Reject / Snooze forms that POST to the Worker. Two follow-up concerns surfaced in the same week — the CSP had to be relaxed to allow same-origin POSTs (`form-action 'self'`), and a promote recipe was interpolating a base-branch name into a shell string without validation.

**Changed**
- Tightened `isSafeBranchName(name)` to a strict `/^[A-Za-z0-9._/-]+$/` allowlist; the promote recipe now falls back to a placeholder if the branch name fails validation, so a maliciously-named branch cannot execute arbitrary shell.
- Added `form-action 'self'` to the CSP so mutation forms POST back to the Worker without opening every other same-origin nav vector.
- Flash-cookie round-trip: mutation POST sets a single-use `flash=<kind>|<msg>` cookie, the next GET reads it and immediately clears it. Toast shows once and only once.
- Test coverage for CSP compliance: `renderHtml: no inline <script> anywhere` runs across every v7 render path.

**Test-count delta:** +18 tests (from 185 to 203).

---

## v7 — 5th-grader triage view (week of 2026-08-04)

**Why this shipped:** the v4 dense table plus the v5 rail plus the v6 theme toggle solved density and skim-ability, but a fresh review with a "junior dev with 15–25 minutes in the morning" hat on made it clear the dashboard was still failing the actual triage flow. The v4 table hid what landed overnight behind what had been sitting for a week; card titles were engineer-code (`fix(auth):`) with no plain-English gloss; the primary CTA (Test in browser) was buried inside a foldout; Approve and Reject were "go open GitHub" chores; no-op PRs rendered identically to real PRs.

**Changed**
- Freshness bins replaced the flat sort. `groupPrsByFreshness(prs, {now})` bins PRs into `{ fresh, yesterday, thisWeek, older }` at wall-clock cutoffs 14h / 38h / 7d. The `older` bin is wrapped in `<details>` and collapsed by default.
- Every card leads with a plain-English summary. `renderPlainEnglishSummary(pr)` maps conventional-commit types to junior-friendly nouns and renders them as `<h4>` at 17px above the engineer title.
- "Check this before approving" is a real checklist. `buildChecklist(pr, group)` layers items from the PR's declared test-route, files-touched heuristics, labels, diff-size guard, and merge-conflict state. Rendered as native `<input type="checkbox">` — no JS, reviewer can physically tick items as they go.
- Test-in-browser is the card's primary CTA (accent cyan pill, leading globe icon). When no `TEST_ROUTE:` marker is on the PR body, the panel renders a muted "No browser test — code-only change (skim the diff)." That negative signal is itself useful.
- Approve / Reject / Snooze mutations moved onto the dashboard. Native `<form method="POST">` with an in-form typed confirmation (`APPROVE` / `REJECT` / `SNOOZE`). Buttons render disabled when the token lacks `Contents:write`, with a tooltip explaining how to widen the scope.
- No-op PRs (0 changed files, or 1 file + 0 total lines, or a "no code changes / already on Staging" body marker) get pulled out of the freshness bins into a collapsed footer section. Never rendered next to real work.
- Continue-in-Claude-Code recipe on every card. `<details>` foldout with a `git fetch + git checkout + claude "<primer>"` recipe in a `user-select: all` `<pre>` — single click selects the whole command.

**Screenshots**
- `screenshots/v7-dark-desktop.png`
- `screenshots/v7-light-desktop.png`
- `screenshots/v7-mobile.png`

**Test-count delta:** +72 tests (from 113 to 185).

---

## v6 — Theme toggle (2026-08-03)

**Why this shipped:** the mission-control dark theme is the identity, but reviewers on iOS Safari with system light preference were getting the dark dashboard forced on them. And in bright kitchen light in the morning, the dark theme was harder to skim than a lighter one.

**Changed**
- Added a full light palette. All colors moved to CSS custom properties; the light block redefines the same tokens under `@media (prefers-color-scheme: light)` and again under `:root[data-theme="light"]`.
- Server-side theme resolution. `resolveTheme(url, cookieHeader)` picks `?theme=` query param > `theme=` cookie > `auto`. The chosen palette is present in the initial HTML — no flash of wrong theme on load.
- Three-pill toggle rendered as `<a href>` links (not `<button>`), so it works with JS disabled. Clicking sets a one-year cookie and reloads.

**Test-count delta:** +11 tests (from 102 to 113).

---

## v5 — Schedule panel (2026-08-03)

**Why this shipped:** "when is the next shift going to fire?" was the fastest-scan question on the dashboard, and the answer required opening `.github/workflows/night-shift-dispatch.yml` in a separate tab. That is exactly the friction the dashboard was supposed to eliminate.

**Changed**
- Added a Shift Schedule panel to the top of the right rail. Renders the night-shift cron expression humanized ("Daily at 23:00 UTC") plus a "next in Xh" countdown and a "last N ago · success" tag.
- Night-shift cron is fetched from the workflow YAML via the GitHub Contents API + base64-decode + regex. One extra API call per repo, cached 30s at the edge. Softens on fetch failure so a missing Contents:Read scope only hides the panel row.
- Cron parser is deliberately narrow: handles `M H * * *`, `M * * * *`, and `*/N * * * *`. Anything else falls through to the raw cron string with a `cron:` prefix. Full cron parsing is a rabbit hole; the shift workflows do not need it.
- Day-shift interval is a hardcoded 30 minutes matching the LaunchAgent's `StartInterval=1800`. Documented as a follow-up to lift into an env var.

**Screenshots**
- `screenshots/schedule-panel.png`

**Test-count delta:** +14 tests (from 88 to 102).

---

## v4 — Dense expandable-row PR table (2026-08-03)

**Why this shipped:** at ~15 open PRs (day + night combined) the previous card list forced 1500+ pixels of vertical scroll and buried tickets that actually needed attention behind the freshest-first order.
Ticket-attempt duplicates (the shift opens PR #1245 → gets stuck → opens #1246 → gets stuck → opens #1247) rendered as three separate cards competing for the same eye.

**Changed**
- Replaced the card list with a dense grid table (`26px caret / 68px #NNNN / 60px ticket / 44px shift / 1fr title / 92px files·delta / 100px status / 92px updated`).
- Ticket-grouping: `groupByTicket(prs)` collapses PRs sharing a ticket id into one row (the newest is `primary`, older attempts become `superseded` and render as a nested list inside the expanded body). Amber `DUP · N` flag pill in the title cell.
- Stale rule: primary older than 5 days → `isStale`, row opacity `0.55`, sorted to the bottom, muted `STALE` flag pill. Hovering un-dims. Stale exists to fade already-known noise, not to hide it.
- Line-delta color coding: `< 100` normal, `100–499` amber, `>= 500` red.
- Below 720px, the row grid collapses via `grid-template-areas` into a two-line-per-row stacked layout. No horizontal overflow ever.
- Section headers with real `<h3>` at 18px, mono eyebrow above, right-side count pills for `open / blockers / dup / ready / stale`.
- Killed the 4-tile KPI grid; replaced with a single "state strip" row above the sections: `15 OPEN | 3 BLOCKERS | 2 DUP | 1 READY | 6 STALE`.

**Test-count delta:** +58 tests (started here).

---

## v0 → v3 — pre-history

Not preserved as separate entries because they never shipped as coherent designs — they were the raw "list open PRs and pending workflow runs" scaffolding on top of which v4 was the first real design pass.

The relevant carryover from that period is the CSP posture, the single-file Worker constraint, the shared-secret query-param auth, and the 30-second edge cache. Those are the environmental constraints; every design decision from v4 onward has to live inside them.
