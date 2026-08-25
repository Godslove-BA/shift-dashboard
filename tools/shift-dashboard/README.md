# shift-dashboard

A mobile-friendly "what are the day-shift + night-shift doing" page. Cloudflare Worker; one HTML page; no JS; auto-refresh every 30s.

**Uses:** on your phone, when Telegram tells you a shift ran and you want the full state at a glance without opening GitHub.

## What it shows

- Count of open day-shift + night-shift PRs (as big stat tiles).
- Last dispatch for each shift with a colored dot (green = passed, red = failed, blue = running).
- Every open shift PR with its status pill (`✓ reviewed-clean`, `⛔ needs human`, `📝 draft`, or plain ready) + a link.
- Last 5 night-shift dispatch runs with pass/fail + timing.

## What it deliberately does NOT do

- **No JS.** Auto-refresh via `<meta http-equiv=refresh>`. Renders on any browser, phones included.
- **No CDN / external assets.** Content-Security-Policy locked down; page is inspectable.
- **No Mac-side signals.** The dashboard can't see the LaunchAgent status (that's local to your Mac). It shows GitHub's view of what shipped, which is what you actually care about anyway.

## Approve / Reject / Snooze from the dashboard (v7)

The dashboard now supports three one-click actions per PR: **Approve & merge** (squash-merges the PR to its holding branch), **Reject** (labels `needs-human`, posts an audit comment), and **Snooze** (labels `snoozed-until-tomorrow`, hides for 24h). Each is gated by an in-form typed confirmation (`APPROVE` / `REJECT` / `SNOOZE`) so a stray click cannot fire.

**These require a widened GH_TOKEN scope.** The read-only setup below still shows the full dashboard, but the mutation buttons render disabled with a tooltip.

To enable mutations, edit the fine-grained PAT at https://github.com/settings/personal-access-tokens and add:

- **Contents** → Read AND write
- **Pull requests** → Read AND write
- **Issues** → Read AND write

(Actions, Metadata stay Read.) Then repush the secret:

```bash
cd tools/shift-dashboard
npx wrangler secret put GH_TOKEN
# paste the new token
```

The dashboard probes `GET /repos/{owner}/{name}` on load and reads `permissions.push` from the response; when true, the action forms render enabled. When false or missing, the buttons stay disabled with the token-widen tooltip. No error page, no user friction beyond the disabled buttons.

## First-time deploy (~5 min)

You need: (a) Cloudflare account (free tier is fine), (b) a GitHub fine-grained PAT with **read-only** scopes on `your-org/your-repo`.

### 1. Create the fine-grained GitHub PAT

Go to https://github.com/settings/personal-access-tokens/new. Configure:

- **Token name:** `shift-dashboard-worker`
- **Expiration:** 1 year (rotate then)
- **Repository access:** "Only select repositories" → pick `your-org/your-repo`
- **Repository permissions** (start read-only; widen later if you want approve/reject/snooze from the dashboard — see the "Approve / Reject / Snooze" section above):
  - Contents → Read-only (Read AND write to enable one-click Approve & merge)
  - Issues → Read-only (Read AND write to enable Reject / Snooze labels + audit comments)
  - Metadata → Read-only (mandatory)
  - Pull requests → Read-only (Read AND write to enable Approve & merge)
  - Actions → Read-only

Click **Generate token** and copy the `github_pat_...` string.

### 2. Generate a dashboard shared secret

```bash
openssl rand -hex 32   # copy the output
```

This is what protects the dashboard URL. Anyone with the URL + this key sees your PR list; without the key they get a plain 404.

### 3. Install wrangler + log in (once per Mac)

```bash
cd tools/shift-dashboard
npx wrangler login    # opens a browser, one time
```

### 4. Set the two secrets on the Worker

```bash
npx wrangler secret put GH_TOKEN
# paste the fine-grained PAT when prompted

npx wrangler secret put DASHBOARD_SECRET
# paste the openssl-rand hex string when prompted
```

### 5. Deploy

```bash
npx wrangler deploy
```

Output ends with:
```
Uploaded shift-dashboard (X sec)
Published shift-dashboard (Y sec)
  https://shift-dashboard.<your-subdomain>.workers.dev
```

### 6. Bookmark on your phone

Open `https://shift-dashboard.<your-subdomain>.workers.dev/?key=<the-secret>` — add to your phone home screen. That's the dashboard.

**Important:** the bookmark IS the credential. Anyone with it sees your dashboard. Treat like a shared password.

## Redeploy after editing

```bash
cd tools/shift-dashboard
npx wrangler deploy
```

Cloudflare atomically swaps in the new version. No downtime. Same URL.

## Local preview

```bash
cd tools/shift-dashboard
npx wrangler dev   # opens http://localhost:8787
```

You'll need to have run `wrangler secret put` for real deploys to succeed; for local dev, set them as env vars in your shell:

```bash
GH_TOKEN=github_pat_... DASHBOARD_SECRET=abc123 npx wrangler dev
```

Then open `http://localhost:8787/?key=abc123`.

## Custom domain (optional)

Cloudflare dashboard → Workers → `shift-dashboard` → Triggers → Custom Domains → add e.g. `shifts.example.com`. Requires that domain to be on Cloudflare DNS. Adds no security by itself — the shared secret still protects it.

## Cost

Cloudflare Workers free tier: 100,000 requests/day. This dashboard auto-refreshes every 30s while a tab is open. If you leave it open all day on your phone AND laptop: `86400s / 30s = 2,880 requests/day`, well under 3% of the free-tier limit.

GitHub API: 5,000 requests/hour authenticated. Each dashboard load makes 4 GH calls, cached 30s at the CF edge. Even under mobile pull-to-refresh abuse, effective GH rate ~8/min = 480/hr. Fine.

## Rotate the shared secret

```bash
cd tools/shift-dashboard
openssl rand -hex 32
npx wrangler secret put DASHBOARD_SECRET   # paste new value
```

Update the bookmark on your phone. Old URL immediately stops working.

## When to move off Cloudflare Workers

Never for this use-case. If the dashboard becomes multi-tenant (multiple projects, multiple users), migrate to a real backend — but at that point you've outgrown "one HTML page" and should probably route through the `your-org/shifts` platform instead (see `tools/day-shift/MULTI_REPO_PLAN.md`).
