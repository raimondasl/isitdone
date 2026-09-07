import { formatDuration, pad, type Style } from './output.js';
import type { Receipt } from './receipt.js';
import type { RunResult } from './run.js';
import type { VerifyResult } from './verify.js';
import { VERSION } from './version.js';

function statusWord(r: RunResult): string {
  return r.status === 'PASS' ? 'PASS' : r.status === 'TIMEOUT' ? 'TIMEOUT' : r.status === 'ERROR' ? 'ERROR' : 'FAIL';
}

function colorStatus(s: Style, r: RunResult): string {
  const w = statusWord(r);
  return r.status === 'PASS' ? s.green(w) : r.status === 'TIMEOUT' ? s.yellow(w) : s.red(w);
}

function detail(r: RunResult): string {
  if (r.status === 'TIMEOUT') return `killed after ${formatDuration(r.timeoutMs)} (isitdone timeout; raise it in .isitdone.json if the check is legitimately slow)`;
  if (r.summary) return r.summary;
  if (r.status === 'FAIL') return `exit ${r.exitCode ?? '?'}`;
  if (r.status === 'ERROR') return r.tail[0] ?? 'could not start';
  return '';
}

function cmdWidth(results: RunResult[]): number {
  return Math.min(40, Math.max(12, ...results.map((r) => r.cmd.length)));
}

/** Human-facing report for the CLI. */
export function formatReport(res: VerifyResult, s: Style): string {
  const lines: string[] = [];
  const g = res.git;
  const where = g.isRepo ? `${g.branch ?? 'detached'}@${g.headShort ?? 'no-commits'}  ${g.dirtyFiles === 0 ? 'clean' : `dirty (${g.dirtyFiles} file${g.dirtyFiles === 1 ? '' : 's'})`}` : 'not a git repo';
  lines.push(`${s.bold('isitdone')}  ${s.dim(where)}${res.claim ? `   claim: ${s.cyan(JSON.stringify(res.claim))}` : ''}`);
  lines.push('');

  if (res.cached && res.receipt) {
    lines.push(`  ${s.green('PASS')} (cached)  receipt from ${res.receipt.createdAt} proves this exact tree; nothing changed since.`);
    for (const r of res.receipt.checks) lines.push(`  ${s.dim(pad(r.cmd, cmdWidth(res.receipt.checks)))}  ${colorStatus(s, r)}  ${s.dim(formatDuration(r.durationMs))}  ${s.dim(detail(r))}`.trimEnd());
    lines.push('');
    lines.push(`  ${s.green(s.bold('DONE'))}   receipt -> PASS (tree ${res.receipt.tree.slice(0, 7)}, ${res.receipt.checks.length} checks, cached)`);
    for (const w of res.warnings) lines.push(`  ${s.yellow('warning: ' + w)}`);
    return lines.join('\n');
  }

  if (res.ran.length === 0 && res.skipped.length === 0) {
    lines.push(`  ${s.yellow('no checks detected')} in ${g.root}`);
    lines.push(`  ${s.dim('isitdone looks for package.json scripts (test/typecheck/lint/build), pytest/ruff/mypy, go.mod, Cargo.toml, .NET, Gradle/Maven and Makefile targets.')}`);
    lines.push(`  ${s.dim('Add your own in .isitdone.json:  { "checks": { "test": "make test" } }')}`);
    for (const n of res.detection.notes) lines.push(`  ${s.dim('note: ' + n)}`);
    return lines.join('\n');
  }

  const w = cmdWidth(res.ran);
  for (const r of res.ran) {
    lines.push(`  ${pad(r.cmd, w)}  ${colorStatus(s, r)}  ${s.dim(pad(formatDuration(r.durationMs), 6))}  ${detail(r)}`.trimEnd());
  }
  for (const sk of res.skipped) {
    lines.push(`  ${s.dim(pad(sk.check.cmd, w))}  ${s.dim('SKIP')}  ${s.dim('      ' + sk.reason)}`.trimEnd());
  }

  const failed = res.ran.filter((r) => r.status !== 'PASS');
  for (const r of failed) {
    lines.push('');
    lines.push(`  ${s.red('--')} ${r.cmd} ${s.dim(`(last ${Math.min(r.tail.length, 15)} of ${r.lines} lines)`)}`);
    for (const l of r.tail.slice(-15)) lines.push(`     ${s.dim(l)}`);
  }
  for (const n of res.detection.notes) lines.push(`  ${s.dim('note: ' + n)}`);
  for (const wn of res.warnings) lines.push(`  ${s.yellow('warning: ' + wn)}`);

  lines.push('');
  if (res.ok) {
    const rc = res.receipt;
    const what = res.profile === 'lite' ? `lite checks passed; full checks not run (${res.skipped.length} skipped)` : `receipt -> PASS (tree ${(rc?.tree ?? '').slice(0, 7)}, ${res.ran.length} checks, ${formatDuration(res.durationMs)})`;
    lines.push(`  ${res.profile === 'lite' ? s.yellow(s.bold('OK (lite)')) : s.green(s.bold('DONE'))}   ${what}`);
  } else {
    lines.push(`  ${s.red(s.bold('NOT DONE'))}   ${failed.length} check${failed.length === 1 ? '' : 's'} failed`);
    lines.push(`  ${s.dim('receipt   .isitdone/receipt.json -> FAIL')}`);
  }
  return lines.join('\n');
}

/**
 * The text an agent sees when its stop is blocked. Plain, bounded (~40 lines), actionable.
 */
export function formatBlockReason(res: VerifyResult, attempt: number, maxAttempts: number): string {
  const lines: string[] = [];
  const failed = res.ran.filter((r) => r.status !== 'PASS');
  const timedOut = failed.filter((r) => r.status === 'TIMEOUT');
  const verb = timedOut.length === failed.length ? 'timed out' : timedOut.length > 0 ? 'failed or timed out' : 'failed';
  lines.push(`isitdone: NOT DONE. ${failed.length} check${failed.length === 1 ? '' : 's'} ${verb} on the current working tree (attempt ${attempt}/${maxAttempts}).`);
  if (res.claim) lines.push(`You claimed: "${res.claim}"`);
  lines.push('');
  const w = cmdWidth(res.ran);
  for (const r of res.ran) lines.push(`  ${pad(r.cmd, w)}  ${statusWord(r)}  ${detail(r)}`.trimEnd());
  for (const sk of res.skipped) lines.push(`  ${pad(sk.check.cmd, w)}  SKIP  ${sk.reason}`);
  const budget = Math.max(4, Math.floor(24 / Math.max(1, failed.length)));
  for (const r of failed) {
    lines.push('');
    lines.push(`--- ${r.cmd} (last ${Math.min(r.tail.length, budget)} lines) ---`);
    for (const l of r.tail.slice(-budget)) lines.push(l.length > 200 ? l.slice(0, 197) + '...' : l);
  }
  lines.push('');
  if (timedOut.length > 0) {
    lines.push(`A TIMEOUT means isitdone killed the check after its time limit, not that the tests failed. If the check is legitimately slow, tell the user to raise "timeout" in .isitdone.json; otherwise look for a hung process or watch mode.`);
  }
  lines.push('Fix the failures, then run `npx isitdone` and paste its output before claiming completion. Do not skip, delete or weaken tests to make this pass; if a check is wrong for this repo, say so explicitly to the user.');
  return lines.join('\n');
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Markdown table for pasting into a PR body. */
export function formatMarkdown(receipt: Receipt, state: string): string {
  const lines: string[] = [];
  lines.push('| check | result | time |');
  lines.push('|---|---|---|');
  for (const r of receipt.checks) {
    const d = detail(r);
    lines.push(`| \`${mdCell(r.cmd)}\` | ${statusWord(r)}${d ? ` (${mdCell(d)})` : ''} | ${formatDuration(r.durationMs)} |`);
  }
  lines.push('');
  const tree = receipt.tree.slice(0, 7);
  const where = receipt.head ? `Tree ${tree} on ${receipt.branch ?? 'detached'}@${receipt.head.slice(0, 7)}${receipt.dirtyFiles ? ` (+${receipt.dirtyFiles} uncommitted)` : ' (clean)'}` : `Tree ${tree}`;
  const label = state === 'PASS' && receipt.profile === 'lite' ? 'PASS (lite: typecheck/lint only, tests not run)' : state;
  lines.push(`${where}. Receipt: **${label}**${receipt.host ? ` · Agent: ${receipt.host}` : ''} · isitdone ${VERSION} · ${receipt.createdAt}`);
  return lines.join('\n');
}

/** Stable machine-readable summary. */
export function toJson(res: VerifyResult, state: string): Record<string, unknown> {
  const checks = res.cached && res.receipt ? res.receipt.checks : res.ran;
  const noChecks = res.detection.checks.length === 0;
  const fullPass = res.ok && !noChecks && (res.cached ? res.receipt?.profile === 'full' : res.profile === 'full' && res.receipt?.profile === 'full');
  return {
    ok: res.ok,
    // done is true only when every full check passed on this exact tree. No checks detected is not "done".
    done: Boolean(fullPass),
    noChecks,
    state,
    profile: res.profile,
    cached: res.cached,
    claim: res.claim,
    git: { root: res.git.root, head: res.git.head, branch: res.git.branch, tree: res.git.tree, dirtyFiles: res.git.dirtyFiles },
    checks: checks.map((r) => ({
      id: r.id,
      cmd: r.cmd,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      summary: r.summary ?? null,
      tail: r.tail,
    })),
    skipped: res.skipped.map((sk) => ({ id: sk.check.id, cmd: sk.check.cmd, reason: sk.reason })),
    stacks: res.detection.stacks,
    notes: res.detection.notes,
    warnings: res.warnings,
    receipt: res.receipt ? { createdAt: res.receipt.createdAt, status: res.receipt.status, profile: res.receipt.profile, tree: res.receipt.tree } : null,
    durationMs: res.durationMs,
    version: VERSION,
  };
}
