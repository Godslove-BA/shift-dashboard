<!-- Thanks for the PR. Please walk this checklist before requesting review. -->

## What this changes

<!-- One paragraph. What behavior or visual output is different after this PR? -->

## Why

<!-- What friction / bug / opportunity drove this? Link the issue if there is one. -->

## Checklist

- [ ] Tests pass locally: `cd tools/shift-dashboard && node --test __tests__/*.test.mjs`
- [ ] `node --check tools/shift-dashboard/worker.js` (no syntax regressions)
- [ ] Screenshots (both themes) if this changes anything visual — attach them below
- [ ] `DESIGN.md` updated if this changes a token, a component, or a design principle
- [ ] `CHANGELOG.md` entry if this ships a new version (v-prefixed section)
- [ ] No new inline `<script>` anywhere (CSP: `default-src 'none'`)
- [ ] No new external asset (CDN font, CDN script, remote image)
- [ ] Works at 390px width (mobile safety)

## Screenshots

<!-- Drop dark + light theme images here for any UI change. -->
