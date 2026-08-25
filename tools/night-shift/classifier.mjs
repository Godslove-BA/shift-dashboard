/**
 * classifier.mjs — safety gate for ticket selection.
 *
 * Returns one of:
 *   "safe"              — workers can take it
 *   "unsafe"            — auth/payments/RLS/migrations/secrets/server.js — never auto
 *   "vague"             — body is too thin to action; director should auto-comment + label
 *   "in-progress"       — labeled "In progress" — human is actively working
 *   "verify-first"      — title looks like it might already be done; preflight should double-check
 *
 * Heuristics are intentionally conservative — false-positive (reject a safe
 * ticket) is much better than false-negative (let a worker touch server.js).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './lib.mjs';

const execFileP = promisify(execFile);

// ─── Heuristic rules ───────────────────────────────────────────────────────

const UNSAFE_LABELS = new Set([
  'auth', 'authentication', 'authorization',
  'payments', 'payment', 'billing', 'stripe',
  'rls', 'row-level-security',
  'security',
  'migration', 'migrations',
  'secrets', 'env', 'env-vars',
  'production-only',
  'do-not-merge',
]);

const SKIP_LABELS = new Set([
  'In progress', 'in progress', 'in-progress',
  // "ready-for-testing" was already in day-shift's ALREADY_CLAIMED regex list
  // but missing here in the shared night-shift classifier - so night-shift would
  // re-dispatch a ticket a human had already marked ready-for-QA. Fixed 2026-07-21.
  'ready-for-testing', 'ready for testing',
  'night-shift:done',
  'night-shift:skipped',
  'night-shift:needs-narrowing',
  'night-shift:needs-human',
  'day-shift:needs-human',
  'won\'t fix', 'wont-fix', 'wontfix',
  'duplicate',
]);

/**
 * Regex hits in title/body that mark a ticket as unsafe regardless of label.
 * Tuned for the source project (R2 mirroring rule, payments, server core).
 */
const UNSAFE_BODY_PATTERNS = [
  /\bRLS\b/,
  /\brow.level.security\b/i,
  /\bauth\b.*\bmiddleware\b/i,
  /\bstripe\b/i,
  /\bwebhook.{0,20}secret\b/i,
  /\bJWT\b/,
  /service_role/i,
  /SUPABASE_SERVICE_ROLE_KEY/i,
  /\bsession\b.*\bhandling\b/i,
  /^\s*\.env/m,                          // env file references at line start
  /supabase\/migrations\//,
  /^\s*server\.js/m,
  /src\/auth\//,
  /src\/services\/stripe/i,
  /src\/services\/billing/i,
  /src\/services\/webhooks\//,
  // Security-hardening tickets — even if they touch a "safe" file, the
  // change class is too risky for autonomous work.
  /\bSSRF\b/,
  /\bCSRF\b/,
  /\bXSS\b/,
  /\bSQL.?injection\b/i,
  /\bharden\b/i,
  /\bvulnerab/i,
  /\bownership\s+check\b/i,
  /\bsecurity\s+(fix|hardening|patch|review)\b/i,
  /\bfail.?open\b/i,
  // Route files — touching any route changes the surface area that can
  // accept user input. Auth/CSRF/rate-limiting concerns live here.
  /src\/routes\//,
  // Database write-side surfaces
  /\bRLS\s+policy\b/i,
  /\bschema\s+change\b/i,
  // OAuth (auth-adjacent — caught after #662 slipped through the auth-middleware-only check)
  /\bOAuth\b/,
  /\btoken\s+refresh\b/i,
  /\bservice\s+account\b/i,
  /\bGoogle\s+(sign|auth|verification|verify|app\s+verification)/i,
  /\bSSO\b/,
  /\bsocial.{0,40}OAuth\b/i,
  // Tier / billing / metering surfaces (touches user-facing pricing — too risky for autonomous)
  /\btier.?aware\b/i,
  /\bbilling\s+engine\b/i,
  /\bsubscription\s+tier\b/i,
  /\bpricing\s+tier\b/i,
  /\busage.based\b/i,
  /\bmetering\b/i,
  /\bcredit\s+account/i,
];

/**
 * Patterns that mark a ticket as "not implementation work" — discussion,
 * planning, backlog placeholder, product decision, etc. Autonomous workers
 * can't usefully act on these. They get rejected to keep the queue clean.
 */
const NON_IMPLEMENTATION_TITLE_PATTERNS = [
  /^product:/i,
  /\bspin\s+out\b/i,
  /\bspinout\b/i,
  /^BACK\s*LOG:/i,
  /\bBACK\s*LOG\b/,
  /^discussion:/i,
  /^proposal:/i,
  /^RFC:/i,
  /^question:/i,
  /^idea:/i,
  /^brainstorm/i,
  // Multi-phase epic work — too big for one autonomous night
  /\bPhases?\s+\d+-\d+\s+of\s+\d+\b/i,
  /\bphase\s+\d+\s+of\s+\d+\b/i,
];

/**
 * Auto-generated daily-issue title pattern that historically correlates with
 * very thin bodies (e.g. oluwafemiadelekan's "X - June 5, 2026"-style tickets).
 * These need a human-narrowing pass first. Rejected as vague, not unsafe.
 *
 * Match shape: any title ending with " - <Month> <Day>[,] <Year>".
 */
const DATE_STAMPED_TITLE_PATTERN = /\s[-—]\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\s*$/i;

/**
 * Verify-first patterns — the ticket text suggests work may already be done.
 * preflight.mjs will confirm.
 */
const VERIFY_FIRST_PATTERNS = [
  /\b(closed|fixed|done|completed|addressed|resolved|merged)\s+(by|in)\s+#?\d+/i,
  /\bsee\s+pr\s+#?\d+/i,
  /\bduplicate\s+of\s+#?\d+/i,
];

// ─── Classification ────────────────────────────────────────────────────────

/**
 * Classify a single GitHub issue (from `gh issue view --json`).
 * Returns { verdict, reasons: [] }.
 */
export function classifyIssue(issue) {
  const reasons = [];

  // 1. Label-based skip (in-progress, already-handled labels)
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name).toLowerCase());
  for (const skip of SKIP_LABELS) {
    if (labelNames.includes(skip.toLowerCase())) {
      reasons.push(`skip-label: ${skip}`);
      return { verdict: 'in-progress', reasons };
    }
  }
  // Any shift-kind claim, from any prior autonomous run. Broadened 2026-07-21
  // after finding tickets like #1143 with both day-shift:review-* AND
  // night-shift:dispatched-* labels (each shift's classifier only knew about
  // its own labels, so both shifts fired on the same ticket).
  //
  // Patterns caught here (any shift's dispatch/review/needs-human/reviewed-clean):
  //   night-shift:dispatched-YYYY-MM-DD    added by tools/night-shift/dispatch.mjs
  //   night-shift:reviewed-clean           added by /morning-review
  //   night-shift:needs-human              added by /morning-review or promote.yml
  //   day-shift:dispatched-YYYY-MM-DD      added by tools/day-shift (future)
  //   day-shift:review-YYYY-MM-DD          added by tools/day-shift/worker.mjs
  //   day-shift:reviewed-clean             added by /desk-review
  //   day-shift:needs-human                added by /desk-review
  const claimedByShiftLabel = labelNames.find((name) =>
    /^(day|night)-shift:(dispatched-|review-|reviewed-clean|needs-human)/.test(name),
  );
  if (claimedByShiftLabel) {
    reasons.push(`skip-label: ${claimedByShiftLabel} (already claimed by shift work)`);
    return { verdict: 'in-progress', reasons };
  }

  // 2. Label-based unsafe
  for (const unsafe of UNSAFE_LABELS) {
    if (labelNames.includes(unsafe)) {
      reasons.push(`unsafe-label: ${unsafe}`);
      return { verdict: 'unsafe', reasons };
    }
  }

  // 3. Title-pattern: non-implementation tickets (planning/product/RFC/etc.)
  const title = issue.title || '';
  for (const re of NON_IMPLEMENTATION_TITLE_PATTERNS) {
    if (re.test(title)) {
      reasons.push(`non-implementation-pattern: ${re.source.slice(0, 60)}`);
      return { verdict: 'unsafe', reasons };
    }
  }

  // 4. Body-pattern unsafe
  const titleAndBody = `${title}\n${issue.body || ''}`;
  for (const re of UNSAFE_BODY_PATTERNS) {
    if (re.test(titleAndBody)) {
      reasons.push(`unsafe-pattern: ${re.source.slice(0, 60)}`);
      return { verdict: 'unsafe', reasons };
    }
  }

  // 5. Date-stamped title (auto-generated daily-issue pattern → vague)
  if (DATE_STAMPED_TITLE_PATTERN.test(title)) {
    reasons.push(`date-stamped-title: matches "<title> - <Month> <Day>, <Year>" pattern (needs human narrowing)`);
    return { verdict: 'vague', reasons };
  }

  // 6. Verify-first
  for (const re of VERIFY_FIRST_PATTERNS) {
    if (re.test(titleAndBody)) {
      reasons.push(`verify-first-pattern: ${re.source.slice(0, 60)}`);
      return { verdict: 'verify-first', reasons };
    }
  }

  // 7. Vagueness gate
  const body = issue.body || '';
  const bodyLen = body.length;
  const hasFilePaths = /\b(src|tests?|scripts|tools)\/[\w./-]+\.\w+/.test(body);
  const hasAcceptanceCriteria = /\b(acceptance|expected|when |should |must )/i.test(body);
  if (bodyLen < 200 && !hasFilePaths && !hasAcceptanceCriteria) {
    reasons.push(`vague: bodyLen=${bodyLen}, no file paths, no acceptance criteria`);
    return { verdict: 'vague', reasons };
  }

  // 8. Default: safe
  reasons.push('passes all gates');
  return { verdict: 'safe', reasons };
}

// ─── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  const [issueNum] = process.argv.slice(2);
  if (!issueNum) {
    process.stderr.write('Usage: node classifier.mjs <issue-number>\n');
    process.exit(2);
  }
  try {
    // Fetch issue via gh CLI
    const { stdout } = await execFileP('gh', [
      'issue', 'view', issueNum,
      '--repo', 'your-org/your-repo',
      '--json', 'number,title,body,labels,state',
    ]);
    const issue = JSON.parse(stdout);
    const result = classifyIssue(issue);
    log('classifier', result.verdict, { issueNum: issue.number, reasons: result.reasons });
    process.stdout.write(JSON.stringify({
      issueNum: issue.number,
      title: issue.title,
      verdict: result.verdict,
      reasons: result.reasons,
    }, null, 2) + '\n');
    // Exit 0 for any verdict — caller reads JSON to decide
  } catch (err) {
    log('classifier', 'error', { issueNum, error: err.message });
    process.stderr.write(`classifier.mjs error: ${err.message}\n`);
    process.exit(1);
  }
}

import url from 'node:url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
