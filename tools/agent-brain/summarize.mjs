/**
 * summarize.mjs - render a BrainRecord as a short markdown block to inject
 * into the worker's system prompt on re-dispatch.
 *
 * Design goals:
 * - Small (≈ 200-500 tokens). The worker system prompt is already dense.
 * - Structured. So an LLM notices "previous attempts failed identically -
 *   do not repeat the same steps."
 * - Ends with hints, because hints are the ONLY line the worker is REQUIRED
 *   to skim per schema.mjs.
 *
 * Emits an empty string when there's nothing to inject (no prior attempts,
 * no verdicts, no hints) - callers can then skip the whole section.
 */

'use strict';

import {
  getActiveHints,
  getAllKeyLearnings,
  getAttemptCount,
  getLastAttempt,
} from './reader.mjs';

const MAX_LEARNINGS = 6;
const MAX_HINTS = 8;
const MAX_LINE = 240;

function clip(text) {
  const t = String(text || '').trim();
  if (t.length <= MAX_LINE) return t;
  return `${t.slice(0, MAX_LINE - 1)}…`;
}

function humanDuration(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m${rem}s` : `${m}m`;
}

/**
 * Build the prompt-injection markdown block.
 * @param {import('./schema.mjs').BrainRecord} record
 * @returns {string}
 */
export function summarizeForPrompt(record) {
  if (!record) return '';
  const attemptCount = getAttemptCount(record);
  const hints = getActiveHints(record);
  const learnings = getAllKeyLearnings(record);
  const last = getLastAttempt(record);

  // Nothing worth saying? Return empty so the caller can skip the section.
  if (attemptCount === 0 && hints.length === 0 && learnings.length === 0) return '';

  const lines = [];
  lines.push(`## PRIOR ATTEMPTS ON THIS TICKET (agent-brain, ticket #${record.ticket_id})`);
  lines.push('');
  lines.push(
    `This ticket has been picked up **${attemptCount}** time(s) before. Do NOT restart from scratch. Read below, then continue where the last attempt left off.`
  );
  lines.push('');

  if (last) {
    const outcome = last.outcome || 'unknown';
    const dur = humanDuration(last.duration_sec);
    const shift = last.shift ? `${last.shift}-shift` : 'shift';
    lines.push(`### Last attempt: ${outcome} (${dur}, ${shift})`);
    if (last.error_summary) lines.push(`- Reason: ${clip(last.error_summary)}`);
    if (last.branch) lines.push(`- Branch: \`${last.branch}\``);
    if (last.pr_url) lines.push(`- PR: ${last.pr_url}`);
    if (Array.isArray(last.files_touched) && last.files_touched.length) {
      const files = last.files_touched.slice(0, 6).join(', ');
      const more = last.files_touched.length > 6 ? ` (+${last.files_touched.length - 6} more)` : '';
      lines.push(`- Files touched: ${files}${more}`);
    }
    lines.push('');
  }

  if (learnings.length) {
    lines.push('### What prior attempts learned');
    for (const l of learnings.slice(0, MAX_LEARNINGS)) {
      lines.push(`- ${clip(l)}`);
    }
    if (learnings.length > MAX_LEARNINGS) {
      lines.push(`- …and ${learnings.length - MAX_LEARNINGS} more (older).`);
    }
    lines.push('');
  }

  if (hints.length) {
    lines.push('### Hints for THIS attempt (act on these)');
    for (const h of hints.slice(0, MAX_HINTS)) {
      const src = h.source ? ` _(${h.source})_` : '';
      lines.push(`- ${clip(h.text)}${src}`);
    }
    if (hints.length > MAX_HINTS) {
      lines.push(`- …and ${hints.length - MAX_HINTS} more.`);
    }
    lines.push('');
  }

  lines.push('---');
  return lines.join('\n');
}
