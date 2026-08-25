/**
 * Shared helpers for night-shift v2 (cloud-only).
 *
 * The original Mac version (~210 lines) had filesystem queues, LaunchAgent
 * lock paths, ~/.night-shift/ config files, and PID heartbeats.
 * Cloud v2 strips all that.
 * The dispatcher runs as a GitHub Action; Codex Cloud is the runtime.
 * No local state, no LaunchAgent, no dashboard.
 *
 * What we keep: `log()` (used by classifier/preflight/git) and `readConfig()`
 * (returns repo + commit identity from env vars).
 */

import process from 'node:process';

const DEFAULT_REPO = 'your-org/your-repo';
const DEFAULT_COMMITTER_NAME = 'Night Shift Bot';
const DEFAULT_COMMITTER_EMAIL = '<your-github-user>@users.noreply.github.com';

/**
 * Structured logger.
 * In GH Actions, output goes to the workflow log.
 * Locally, to stderr.
 * Each line is timestamped + tagged with a level so morning review can grep it.
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
log.debug = (...a) => (process.env.NIGHT_SHIFT_DEBUG ? log('DEBUG', ...a) : undefined);

/**
 * Cloud-friendly config reader.
 * Original Mac version read ~/.night-shift/config.json.
 * Cloud reads from env vars (set by GH Action workflow inputs / repo secrets).
 *
 * Returned shape matches what preflight.mjs + git.mjs expect.
 */
export function readConfig() {
  return {
    repo: process.env.NIGHT_SHIFT_REPO || DEFAULT_REPO,
    githubToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
    maxTickets: Number(process.env.MAX_TICKETS) || 1,
    mode: process.env.MODE || 'auto',
    commitIdentity: {
      name: process.env.NIGHT_SHIFT_COMMITTER_NAME || DEFAULT_COMMITTER_NAME,
      email: process.env.NIGHT_SHIFT_COMMITTER_EMAIL || DEFAULT_COMMITTER_EMAIL,
    },
    nightShiftBaseBranch: process.env.NIGHT_SHIFT_BASE_BRANCH || 'Staging',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  };
}

/**
 * Helper for the dated batch branch.
 * Returns e.g. "night-shift-staging-2026-06-23".
 * Codex Cloud agents create-if-not-exists from `Staging`.
 */
export function todaysBatchBranch(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `night-shift-staging-${y}-${m}-${d}`;
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
 * Telegram outbound notification.
 * No-op if TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing - non-fatal so dispatch.mjs always finishes.
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
