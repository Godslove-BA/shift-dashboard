# Design System — shift-dashboard

The dashboard exists to give one person a fifteen-minute answer to "what happened overnight, and what needs my eyes right now?"
Every design decision below is downstream of that one job.

This document is the contract between the visual identity and the code.
Adding new UI without reading this first is how a page ends up with four different corner radii and three shades of the same accent.

## Design principles

### 1. Progress over correctness

The dashboard is not a settings surface, an admin console, or a source-of-truth for anything.
It is a triage view.
If a card renders slightly wrong data because a PR is malformed, that is preferable to the card refusing to render at all.
Every fetch is wrapped in a `soft()` helper that turns a rejecting promise into `{ error: <message> }`; a missing scope on one repo hides one panel row, it never breaks the page.
The page returns HTTP 200 even on hard errors so a phone-cached bookmark does not turn into a "site down" ghost.

### 2. The 5th-grader test

If a junior dev in their first fortnight cannot tell what a card is asking them to do at a glance, the card is wrong.
Every triage card leads with a plain-English summary (`fix → Fix`, `feat → New feature`, `chore → Housekeeping`, etc.) at 17px, 600 weight.
The engineer title stays visible in muted 12px mono directly below it — audit-visible, but it recedes.
Titles ending in `(#1234)` have that suffix stripped from the plain form because the ticket link is already one row up.

### 3. Native HTML first

Server-rendered HTML with a `default-src 'none'` CSP.
Zero JavaScript at runtime.
Disclosure is native `<details>`.
Forms are native `<form method="POST">` with `<input required pattern="APPROVE">` as the mutation gate.
Theme switching is a URL parameter and a cookie the Worker reads server-side.
Recipe blocks use `user-select: all` so a single click selects the whole command and the reviewer can copy-paste without a JavaScript button.

### 4. CSP-clean by construction

The Content-Security-Policy is `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'`.
That header is not something the code has to maintain — it is what the code has to work under.
The rule is: any new UI that would need a `<script>` tag, an external CDN, or a `fetch()` from the browser is out of scope.
If the constraint feels annoying, that is the design working as intended.

### 5. Freshness beats file-count for triage

A PR opened three days ago that touches four files is less urgent than a PR opened four hours ago that touches one file.
The old flat-sort-by-updated-at view hid that.
The current view bins PRs into four freshness sections — `Since you were last here` (14h), `Yesterday` (38h), `Earlier this week` (7d), and `Older` (collapsed) — before any other sort.
The cutoffs are wall-clock human intervals, not `now - 24h`, so a review at 8 a.m. covers the whole night.

## Color tokens

Use CSS custom properties everywhere.
Never hardcode a hex in a component.
Add a new token if you need a new shade.

### Dark (the default, the identity)

```css
:root {
  --bg:          #0A0E12;
  --bg-nav:      #060A0D;
  --card:        #12171D;
  --card-hi:     #1A2028;
  --pill:        #1E2530;
  --line:        #1E2530;
  --line-hi:     #2A3340;
  --fg:          #E8ECEF;
  --fg-hi:       #FFFFFF;
  --muted:       #6B7580;
  --muted-hi:    #8A939E;

  --accent:      #14E3D5;  /* primary cyan/teal - one per element */
  --accent-dim:  #0EA89E;
  --warn:        #F5A623;  /* amber - warnings, needs-human */
  --warn-dim:    #C77D0E;
  --danger:      #E86450;  /* red - blockers only */
  --danger-dim:  #B14232;
  --success:     #4ADE80;  /* green - confirmed-success only */
}
```

### Light (courtesy theme)

```css
@media (prefers-color-scheme: light) {
  :root {
    --bg:      #F7F8FA;
    --bg-nav:  #EDEFF3;
    --card:    #FFFFFF;
    --card-hi: #F2F4F7;
    --pill:    #F2F4F7;
    --line:    #E4E7EC;
    --line-hi: #D0D5DD;
    --fg:      #101828;
    --fg-hi:   #050B18;
    --muted:   #667085;
    --muted-hi:#475467;
    --accent:  #0BB8AC;
    --warn:    #E08804;
    --danger:  #C4442F;
    --success: #16A34A;
  }
}
```

The theme resolves in three states — `auto` (default, honors OS preference), `dark` (explicit), `light` (explicit).
`resolveTheme(url, cookieHeader)` picks: `?theme=` query param wins, then a `theme=` cookie, then falls back to `auto`.
An explicit `?theme=dark|light` persists to a one-year cookie so a subsequent visit on a different device inherits the choice.
`?theme=auto` clears the cookie so the OS preference wins via `prefers-color-scheme`.

## Typography

Two families, both system stacks.
No web fonts — the CSP forbids them, and a good system stack is faster and more legible on the reviewer's actual device.

```css
--font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
```

### Scale

| Role | Size / Weight / Family | Where |
|------|------------------------|-------|
| Page hero (`h1`) | 34px / 700 / body | "Shift dashboard" |
| Section heading (`h3`) | 20px / 600 / body | "Since you were last here" |
| Card plain-English summary (`h4.tri-plain`) | 17px / 600 / body, `--fg-hi` | Loudest inside a card |
| Card engineer title (`p.tri-eng`) | 12px / 400 / mono, `--muted` | Audit-visible, recedes |
| Section eyebrow | 11px / 500 / mono, uppercase, tracking `0.14em` | "OPEN PULL REQUESTS" |
| Body | 14px / 400 / body | Card content |
| Big stat | 32px / 700 / body, `tabular-nums` | KPI tiles |
| Code / URL / ID | 12px / 400 / mono | `#T-041`, timestamps |

`font-variant-numeric: tabular-nums` on every number that lines up in a column.
Always.

`text-wrap: balance` on `h1`. `text-wrap: pretty` on body prose. Never let headings ragged-break.

**The hierarchy rule that carries forward from v4:** if two things look equally important, one of them is wrong.

## Component inventory

### Section eyebrow + heading pair

Every content block starts with a mono uppercase eyebrow above the human-readable heading.

```html
<div class="eyebrow">◇ QUEUE HEALTH</div>
<h2>Ticket Pipeline</h2>
```

The leading glyph (◇, ▸, or a colored dot) is optional but common — it gives the eyebrow a marker to hook the eye.
Dots carry state: cyan = live, amber = attention, red = blocker.

### Status pill

Small caps, tracking-wide, colored per state. Leading dot indicator.

```html
<span class="pill pill-accent">● OPEN</span>
<span class="pill pill-warn">● NEEDS HUMAN</span>
<span class="pill pill-danger">● BLOCKER</span>
```

Radius `6px` or full pill, `2px 8px` padding, 11px mono uppercase.

### Card (triage)

- Background `var(--card)`.
- Border `1px solid var(--line)`.
- Radius `10px`.
- Optional left-border accent for state-carrying cards: `border-left: 3px solid var(--accent | warn | danger | success)`. Everything else gets the neutral border.
- Padding `16px 18px` (comfortable) or `12px 14px` (compact).

### Freshness section

Each of the four freshness bins renders as a `<section class="fresh-group">` with a heading and body.
The `older` bin is wrapped in `<details>` and collapsed by default so a week-old PR does not dominate the page.

### Buttons

- **Primary** (rare — one per card ideally): pill radius, subtle accent tint on dark, leading icon. Used for "🌐 Test in browser".
- **Secondary** (many): pill radius, plain card background with a border, hover lifts to `--card-hi`.
- **Danger / approval**: same shape as secondary, tinted with `--warn` or `--danger`.
- **Disabled**: `.btn-disabled` with a tooltip explaining why (usually a missing token scope).

### Recipe / code block

For any block the reviewer is expected to select and copy:

```css
pre.recipe {
  background: var(--bg);
  border: 1px solid var(--line-hi);
  border-radius: 4px;
  padding: 8px 10px;
  font: 11.5px/1.5 var(--font-mono);
  user-select: all;
  overflow-x: auto;
  white-space: pre;
}
```

`user-select: all` is how the "copy the recipe" affordance works without JavaScript.

### Progress bar

Thin (4px), dark track (`--pill`), cyan fill (`--accent`). No load animation — just the fill.

### KPI stat tile

Eyebrow → big number (32px / 700 / tabular-nums) → sub-caption (small, muted).

### Attention panel

State-that-needs-eyes gets a colored left border plus a tinted background:

```css
.panel-attention {
  border-left: 3px solid var(--warn);
  background: color-mix(in srgb, var(--warn) 6%, var(--card));
}
```

Reserved for genuine "you need to look at this" callouts — needs-human PRs, blockers.
Not for the whole main content area.

## State grammar

Every state the dashboard represents has both a visual signal and an aria label.

| State | Visual | ARIA / semantic |
|-------|--------|-----------------|
| Idle | Muted dot, muted text | `aria-label="idle"` on the dot |
| Loading | (never — page is server-rendered) | n/a |
| Success | `--success` dot, checkmark glyph | `aria-label="success"` |
| Warning | `--warn` dot, amber pill | `aria-label="warning"` |
| Blocker / error | `--danger` left border, red pill | `aria-label="blocker"` |
| Needs-human | `--warn` panel with left border | `aria-label="needs human"` |
| Merged | `--success` pill | `aria-label="merged"` |

Live progress uses a cyan pulsing dot; the pulse comes from `@keyframes` in the inline `<style>` block (CSS animation is CSP-clean; JavaScript is not).

## Freshness grouping rationale

The four buckets are `fresh` (< 14h), `yesterday` (14–38h), `thisWeek` (38h–7d), `older` (> 7d).
The cutoffs are deliberately wall-clock intervals, not `now - 24h`.

At 8 a.m. the reviewer wants "what happened overnight" — a 14-hour window catches everything the shifts ran between 6 p.m. and 8 a.m.
`Yesterday` extends to 38h so a PR opened at 11 p.m. two days ago still lands in yesterday, not thisWeek, at any review time before noon.
`Older` collapses because a PR that has been open for more than a week is either abandoned or being ignored deliberately, and either way it should not steal attention from the fresh work.

Alternatives considered and rejected:
- **Rolling 24-hour window.** Made the boundary jitter based on review time. A PR that was "yesterday" at 8 a.m. was "today" at 7 a.m. — same PR, wrong bucket.
- **Kanban columns (open / in-progress / needs-review / done).** GitHub's Projects surface already exists for this and the dashboard is not competing with it. The triage question is temporal, not workflow-stage.
- **Sort by additions + deletions descending.** Made large refactors dominate over small blocker fixes. Wrong lens for triage; right lens for code review.

## Theme toggle mechanism

The toggle is three pill buttons rendered as `<a href>` links — `Light`, `Dark`, `Auto`.
Clicking one navigates to `/?theme=light|dark|auto&key=...`.
The Worker reads the `theme` query param, sets a one-year cookie, and returns the page rendered with the chosen palette.

Why not client-side JavaScript?
Two reasons.
First, the CSP forbids inline `<script>` and there is no external JS to load.
Second, doing it server-side means the correct palette is present in the initial HTML — no flash-of-wrong-theme on load, which is the specific bug a JavaScript theme toggle usually ships with.

The cost is one full page refresh per toggle, which at ~200ms on the edge feels instant on Wi-Fi and takes about a second on 3G. Both cheaper than the flash of wrong theme on a JS solution.

## Accessibility notes

- **Contrast**: every text/background pair hits WCAG-AA (4.5:1 for body, 3:1 for large text) in both themes. Validated with the WebAIM contrast checker; tokens are chosen so that swapping in a new hue on a component just works.
- **Focus rings**: every interactive element (link, button, input, `<details>` summary) has a visible focus ring in `--accent`. Keyboard nav walks the page in the order the content reads.
- **Tap targets**: 44×44px minimum on mobile; the primary CTA buttons on triage cards are 48px tall by default.
- **Screen reader**: freshness sections use real `<h3>` headings so the reader can jump between them via H navigation. Action buttons are real `<button>` inside `<form>` (not styled `<a>`).
- **Mobile-safe at 390px**: no horizontal overflow on the body; wide content scrolls inside its own `overflow-x: auto` container. The two-column desktop grid collapses to one column below 720px.
- **Motion**: the only animation on the page is the cyan pulsing dot on live-state pills; it respects `prefers-reduced-motion` and drops to a static color when set.

## When you're adding new UI

1. Read this document. The tokens and component conventions above are the contract.
2. Reuse an existing component if one fits. Only add a new token if no existing one covers the shade you need; if you add one, comment why next to the declaration.
3. Test both themes. Set `data-theme="dark"` and `data-theme="light"` on `:root` and verify contrast in both.
4. CSP is `default-src 'none'`. No inline JavaScript. No external fonts. No external images. Data URIs and inline `<style>` only.
5. Mobile-safe. Every layout must work at 390px width. No horizontal overflow on the body.
6. If two things look equally important, one of them is wrong.
