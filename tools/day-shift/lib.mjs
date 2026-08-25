/**
 * Shared helpers for DAY SHIFT — the local, Claude-Code-driven twin of night-shift.
 *
 * Night-shift v2 runs in GitHub Actions + Codex Cloud (metered cloud runtime).
 * Day-shift runs LOCALLY on the user's awake Mac, driven by `claude -p`
 * (the Claude subscription — $0 marginal cost, burns the unused monthly
 * token allowance instead of paying for Codex Cloud / Claude routines).
 *
 * It reuses night-shift's safety brain verbatim (classifyIssue + verifyFirst,
 * imported from ../night-shift/) and only swaps the RUNTIME: instead of posting
 * an `@codex` comment and walking away, day-shift does the work itself in a
 * worktree and opens a DRAFT PR to a dated HOLDING branch the user promotes.
 *
 * Naming differs from night-shift so the two systems never collide:
 *   night-shift → branches `nightshift/*`, holding `night-shift-staging-*`, label `night-shift:*`
 *   day-shift   → branches `dayshift/*`,   holding `day-shift-staging-*`,   label `day-shift:*`
 */

import process from 'node:process';

const DEFAULT_REPO = 'your-org/your-repo';
const DEFAULT_COMMITTER_NAME = 'Day Shift Bot';
const DEFAULT_COMMITTER_EMAIL = '<your-github-user>@users.noreply.github.com';

/**
 * Structured logger. Timestamped + level-tagged so a desk-review can grep it.
 * Locally, output goes to stderr (and the LaunchAgent log file).
 */
export function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stderr.write(`[${ts}] [${level}] ${msg}\n`);
}
log.info = (...a) => log('INFO', ...a);
log.warn = (...a) => log('WARN', ...a);
log.error = (...a) => log('ERROR', ...a);
log.debug = (...a) => (process.env.DAY_SHIFT_DEBUG ? log('DEBUG', ...a) : undefined);

/**
 * Simple concurrency-capped parallel pool. N async workers pull from a shared
 * queue and settle into `results` in ORIGINAL positional order (not
 * completion order). No 3rd-party dep - Node builtins only, matching the rest
 * of the shift-tools posture.
 *
 * Contract:
 *  - `fn(item, i)` is awaited for each item; whatever it returns becomes
 *    `results[i]`.
 *  - `concurrency` is clamped `[1, items.length]` so an oversized cap doesn't
 *    spin idle promise slots.
 *  - If `fn` throws, this pool REJECTS with that error (Promise.all semantics).
 *    Callers who want batch-continues-on-throw semantics must wrap `fn` in a
 *    try/catch of their own - dispatch.mjs does this in the worker fan-out.
 */
export async function runInParallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const cap = Math.max(1, Math.min(concurrency, items.length));
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: cap }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Config reader. Reads from env vars (set by the LaunchAgent plist or shell).
 * Mirrors night-shift's readConfig shape so reused modules stay compatible.
 */
export function readConfig() {
  return {
    repo: process.env.DAY_SHIFT_REPO || process.env.NIGHT_SHIFT_REPO || DEFAULT_REPO,
    githubToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
    maxTickets: Number(process.env.MAX_TICKETS) || 1,
    // Concurrency for the worker fan-out inside one dispatch run. Default 1 =
    // legacy serial behaviour (no risk of surprising an existing install).
    // 3 is the tested sweet spot on a 16GB M-series Mac (each `claude -p`
    // peaks at ~1-2GB RAM + 1 core). Above 4 gives diminishing returns AND
    // burns the Claude Max 5-hour quota N× faster. Clamped [1, 6].
    concurrency: Math.max(1, Math.min(Number(process.env.CONCURRENCY) || 1, 6)),
    mode: process.env.MODE || 'auto', // 'auto' | 'dry-run'
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    maxIterMinutes: Number(process.env.DAY_SHIFT_MAX_MINUTES) || 25, // hard wall-clock cap per ticket
    worktreeRoot:
      process.env.DAY_SHIFT_WORKTREE_ROOT ||
      `${process.env.HOME}/day-shift-worktrees`,
    primaryRepo: process.env.DAY_SHIFT_PRIMARY_REPO || process.cwd(),
    baseBranch: process.env.DAY_SHIFT_BASE_BRANCH || 'Staging',
    commitIdentity: {
      name: process.env.DAY_SHIFT_COMMITTER_NAME || DEFAULT_COMMITTER_NAME,
      email: process.env.DAY_SHIFT_COMMITTER_EMAIL || DEFAULT_COMMITTER_EMAIL,
    },
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  };
}

/**
 * Dated holding branch — the "pre-staging place".
 * Returns e.g. "day-shift-staging-2026-06-24". Deploys NOWHERE; the user
 * promotes it to Staging by hand after review.
 */
export function todaysHoldingBranch(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `day-shift-staging-${y}-${m}-${d}`;
}

/** "day-shift:done-2026-06-24"-style label suffix for a holding branch. */
export function labelDateSuffix(now = new Date()) {
  return todaysHoldingBranch(now).replace('day-shift-staging-', '');
}

/**
 * Slug an issue title for branch naming.
 * e.g. "fix(cinematic): cursor misalignment" → "fix-cinematic-cursor-misalignme"
 */
export function slugifyTitle(title, maxLen = 32) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
}

/**
 * Telegram outbound notification. No-op if not configured — non-fatal so the
 * dispatcher always finishes.
 */
export async function notifyTelegram(text, opts = {}) {
  const { telegramBotToken: token, telegramChatId: chatId } = readConfig();
  if (!token || !chatId) {
    log.debug('telegram not configured, skipping notify');
    return { ok: false, reason: 'not-configured' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: opts.parseMode || 'Markdown',
        disable_web_page_preview: opts.disableWebPreview ?? true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      log.warn('telegram send failed', { status: res.status, body });
      return { ok: false, status: res.status, body };
    }
    return { ok: true };
  } catch (err) {
    log.warn('telegram send threw', err.message);
    return { ok: false, error: err.message };
  }
}
