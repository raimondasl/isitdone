import type { IsitdoneConfig } from './config.js';
import type { Detection } from './detect.js';
import { formatSummaryLine, type Finding, type IntegrityReport } from './integrity.js';
import { formatDuration, pad, type Style } from './output.js';
import type { Receipt, ReceiptEvaluation } from './receipt.js';
import type { RunResult } from './run.js';
import { timeoutFor, type VerifyResult } from './verify.js';
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

function findingLine(f: Finding): string {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `${where}  ${f.message}${f.suppressed ? `  (allowed: ${f.suppressed})` : ''}  [${f.severity}]`;
}

/** The "test integrity" block shared by the CLI report and the hook reason. */
export function formatIntegrity(res: VerifyResult, s: Style, maxFindings = 12): string[] {
  const it = res.integrity;
  if (!it) return [];
  const lines: string[] = [];
  const touched = it.testFiles > 0 || it.findings.length > 0;
  if (!touched) return [];
  const head = `  ${s.bold('test integrity')}   ${formatSummaryLine(it.summary)}`;
  lines.push(head);
  if (it.findings.length === 0) {
    lines.push(`    ${s.green('none')}  ${s.dim(`${it.testFiles} test file${it.testFiles === 1 ? '' : 's'} changed, nothing weakened`)}`);
    return lines;
  }
  for (const f of it.findings.slice(0, maxFindings)) {
    const sev = f.severity === 'critical' || f.severity === 'high' ? s.red(f.severity) : f.severity === 'medium' ? s.yellow(f.severity) : s.dim(f.severity);
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`    ${pad(where, 40)}  ${f.message}${f.suppressed ? s.dim(`  (allowed: ${f.suppressed})`) : ''}  ${sev}`);
    if (f.evidence && f.id !== 'tests-removed' && f.id !== 'assertions-removed' && f.id !== 'test-file-deleted') {
      for (const ev of f.evidence.split('\n').slice(0, 2)) lines.push(`      ${s.dim(ev)}`);
    }
  }
  if (it.findings.length > maxFindings) lines.push(`    ${s.dim(`... ${it.findings.length - maxFindings} more`)}`);
  const mode = res.integrityMode === 'strict' ? 'strict: high/critical findings block' : 'warn only; set "integrity": "strict" in .isitdone.json to block';
  lines.push(`    ${s.dim(mode)}`);
  return lines;
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
    const integrity = formatIntegrity(res, s);
    if (integrity.length) lines.push('', ...integrity);
    lines.push('');
    // A lite receipt only proves typecheck/lint: reusing it is OK for a lite run, never "DONE".
    if (res.receipt.profile === 'lite') lines.push(`  ${s.yellow(s.bold('OK (lite)'))}   lite checks passed on this exact tree (tree ${res.receipt.tree.slice(0, 7)}, cached); full checks not run`);
    else lines.push(`  ${s.green(s.bold('DONE'))}   receipt -> PASS (tree ${res.receipt.tree.slice(0, 7)}, ${res.receipt.checks.length} checks, cached)`);
    for (const w of res.warnings) lines.push(`  ${s.yellow('warning: ' + w)}`);
    return lines.join('\n');
  }

  if (res.ran.length === 0 && res.skipped.length === 0) {
    lines.push(`  ${s.yellow('no checks detected')} in ${g.root}`);
    lines.push(`  ${s.dim('isitdone looks for package.json scripts (test/typecheck/lint/build), pytest/ruff/mypy, go.mod, Cargo.toml, .NET, Gradle/Maven and Makefile targets.')}`);
    lines.push(`  ${s.dim('Add your own in .isitdone.json:  { "checks": { "test": "make test" } }')}`);
    for (const n of res.detection.notes) lines.push(`  ${s.dim('note: ' + n)}`);
    const integrity = formatIntegrity(res, s);
    if (integrity.length) lines.push('', ...integrity);
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
  const integrity = formatIntegrity(res, s);
  if (integrity.length) lines.push('', ...integrity);
  for (const n of res.detection.notes) lines.push(`  ${s.dim('note: ' + n)}`);
  for (const wn of res.warnings) lines.push(`  ${s.yellow('warning: ' + wn)}`);

  lines.push('');
  const blockedByIntegrity = res.ok && integrityBlocks(res);
  if (res.ok && !blockedByIntegrity) {
    const rc = res.receipt;
    const what = res.profile === 'lite' ? `lite checks passed; full checks not run (${res.skipped.length} skipped)` : `receipt -> PASS (tree ${(rc?.tree ?? '').slice(0, 7)}, ${res.ran.length} checks, ${formatDuration(res.durationMs)})`;
    lines.push(`  ${res.profile === 'lite' ? s.yellow(s.bold('OK (lite)')) : s.green(s.bold('DONE'))}   ${what}`);
  } else if (blockedByIntegrity) {
    lines.push(`  ${s.red(s.bold('NOT DONE'))}   checks passed but ${res.integrity?.blocking.length} test-integrity finding${res.integrity?.blocking.length === 1 ? '' : 's'} block${res.integrity?.blocking.length === 1 ? 's' : ''} in strict mode`);
  } else {
    lines.push(`  ${s.red(s.bold('NOT DONE'))}   ${failed.length} check${failed.length === 1 ? '' : 's'} failed`);
    lines.push(`  ${s.dim('receipt   .isitdone/receipt.json -> FAIL')}`);
  }
  return lines.join('\n');
}

/** Strict mode: unsuppressed high/critical integrity findings block even when the checks pass. */
export function integrityBlocks(res: VerifyResult): boolean {
  return res.integrityMode === 'strict' && (res.integrity?.blocking.length ?? 0) > 0;
}

/** Uncommitted files of another agent session working in the same directory, for the block reason. */
export interface OtherSessionNote {
  /** Files the other session edited and this one did not. */
  foreign: { path: string; ago: string }[];
  /** Files both sessions edited. */
  shared: { path: string; ago: string }[];
  lastActive: string | null;
  /** Nothing in the failing output names a file this session edited: it is told once and released after the next run. */
  soft: boolean;
}

const MAX_NOTE_FILES = 10;

function otherSessionLines(note: OtherSessionNote): string[] {
  const lines: string[] = [];
  const list = (xs: OtherSessionNote['foreign']) => {
    for (const x of xs.slice(0, MAX_NOTE_FILES)) lines.push(`  ${x.path}  (edited ${x.ago})`);
    if (xs.length > MAX_NOTE_FILES) lines.push(`  ... ${xs.length - MAX_NOTE_FILES} more`);
  };
  lines.push(`ANOTHER AGENT SESSION HAS BEEN WORKING IN THIS SAME DIRECTORY WHILE YOU WERE${note.lastActive ? ` (its last hook activity: ${note.lastActive})` : ''}. The checks see its unfinished work too.`);
  if (note.foreign.length > 0) {
    lines.push('These uncommitted files are its work in progress, not yours:');
    list(note.foreign);
    lines.push('Do not edit, revert or "fix" them, and do not run git commands that would discard them (checkout, restore, reset, stash, clean).');
  }
  if (note.shared.length > 0) {
    lines.push('Both of you have edited these; re-read them before editing and keep the other session\'s changes:');
    list(note.shared);
  }
  return lines;
}

/**
 * The text an agent sees when its stop is blocked. Plain, bounded (~40 lines), actionable.
 */
export function formatBlockReason(res: VerifyResult, attempt: number, maxAttempts: number, otherSession: OtherSessionNote | null = null): string {
  const lines: string[] = [];
  const failed = res.ran.filter((r) => r.status !== 'PASS');
  const timedOut = failed.filter((r) => r.status === 'TIMEOUT');
  const onlyIntegrity = failed.length === 0 && integrityBlocks(res);
  if (onlyIntegrity) {
    lines.push(`isitdone: NOT DONE. The checks pass, but the change weakened the tests (attempt ${attempt}/${maxAttempts}). [isitdone ${VERSION}]`);
  } else {
    const verb = timedOut.length === failed.length ? 'timed out' : timedOut.length > 0 ? 'failed or timed out' : 'failed';
    lines.push(`isitdone: NOT DONE. ${failed.length} check${failed.length === 1 ? '' : 's'} ${verb} on the current working tree (attempt ${attempt}/${maxAttempts}). [isitdone ${VERSION}]`);
  }
  if (res.claim) lines.push(`You claimed: "${res.claim}"`);
  if (otherSession) lines.push('', ...otherSessionLines(otherSession));
  lines.push('');
  const w = cmdWidth(res.ran);
  for (const r of res.ran) lines.push(`  ${pad(r.cmd, w)}  ${statusWord(r)}  ${detail(r)}`.trimEnd());
  for (const sk of res.skipped) lines.push(`  ${pad(sk.check.cmd, w)}  SKIP  ${sk.reason}`);
  const budget = Math.max(4, Math.floor(20 / Math.max(1, failed.length)));
  for (const r of failed) {
    lines.push('');
    lines.push(`--- ${r.cmd} (last ${Math.min(r.tail.length, budget)} lines) ---`);
    for (const l of r.tail.slice(-budget)) lines.push(l.length > 200 ? l.slice(0, 197) + '...' : l);
  }
  const it = res.integrity;
  if (it && it.findings.length > 0) {
    lines.push('');
    lines.push(`test integrity   ${formatSummaryLine(it.summary)}`);
    for (const f of it.findings.slice(0, 8)) lines.push(`  ${findingLine(f)}`);
    if (it.findings.length > 8) lines.push(`  ... ${it.findings.length - 8} more`);
  }
  lines.push('');
  if (timedOut.length > 0) {
    lines.push(`A TIMEOUT means isitdone killed the check after its time limit, not that the tests failed. If the check is legitimately slow, tell the user to raise "timeout" in .isitdone.json; otherwise look for a hung process or watch mode.`);
  }
  if (onlyIntegrity) {
    lines.push('Restore the removed or weakened tests (or explain to the user why the change to the tests is correct), then run `npx isitdone` before claiming completion.');
  } else if (otherSession && otherSession.soft) {
    lines.push('Nothing in this output names a file you edited, so first work out whether your change caused it (a changed type, signature or fixture can break a file you never opened). If it did, fix YOUR change, in your own files. If it did not, tell the user exactly that and stop: isitdone will run the checks once more and let you stop if the output still names none of your files. Do not skip, delete or weaken tests to make this pass.');
  } else if (otherSession && otherSession.foreign.length > 0) {
    lines.push('Fix the failures in your own files, then run `npx isitdone`. Failures that remain in the other session\'s files are not yours to fix: leave them and tell the user. Do not skip, delete or weaken tests to make this pass.');
  } else {
    lines.push('Fix the failures, then run `npx isitdone` and paste its output before claiming completion. Do not skip, delete or weaken tests to make this pass; if a check is wrong for this repo, say so explicitly to the user.');
  }
  return lines.join('\n');
}

/** `isitdone receipt` for humans; the MCP isitdone_receipt tool prints the same lines. `fullRun` is how to get a full receipt. */
export function formatReceiptState(ev: ReceiptEvaluation, s: Style, fullRun: string): string {
  const color = ev.state === 'PASS' ? s.green : ev.state === 'FAIL' ? s.red : s.yellow;
  const label = ev.state === 'PASS' && ev.receipt?.profile === 'lite' ? 'PASS (lite)' : ev.state;
  const lines = [`${s.bold('isitdone receipt')}  ${color(s.bold(label))}  ${s.dim(ev.reason)}`];
  if (ev.receipt) {
    const r = ev.receipt;
    lines.push(`  ${s.dim(`created ${r.createdAt} on ${r.branch ?? 'detached'}@${(r.head ?? '').slice(0, 7)} tree ${r.tree.slice(0, 7)}, profile ${r.profile}${r.host ? `, host ${r.host}` : ''}`)}`);
    for (const c of r.checks) lines.push(`  ${c.cmd}  ${c.status === 'PASS' ? s.green('PASS') : s.red(c.status)}  ${s.dim(formatDuration(c.durationMs))}  ${s.dim(c.summary ?? '')}`.trimEnd());
    if (r.claim) lines.push(`  ${s.dim('claim: ' + JSON.stringify(r.claim))}`);
    if (ev.state === 'PASS' && r.profile === 'lite') lines.push(`  ${s.yellow(`tests were not run; ${fullRun} for a full receipt`)}`);
  }
  return lines.join('\n');
}

/** `isitdone detect` for humans; the MCP isitdone_detect tool prints the same lines. */
export function formatDetection(root: string, d: Detection, config: IsitdoneConfig, source: string | null, s: Style): string {
  const lines = [`${s.bold('isitdone detect')}  ${s.dim(root)}${source ? s.dim(`  (config: ${source})`) : ''}`];
  if (d.checks.length === 0) lines.push(`  ${s.yellow('no checks detected')}`);
  for (const c of d.checks) lines.push(`  ${s.cyan(c.id.padEnd(10))} ${c.cmd.padEnd(32)} ${s.dim(`${c.kind}  ${timeoutFor(c, config) / 1000}s  from ${c.source}`)}`);
  for (const n of d.notes) lines.push(`  ${s.dim('note: ' + n)}`);
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
  if (receipt.integrity) {
    const it = receipt.integrity;
    const unsuppressed = it.findings.filter((f) => !f.suppressed);
    if (unsuppressed.length === 0) lines.push(`Tests weakened: none (${formatSummaryLine(it.summary)}).`);
    else lines.push(`Tests weakened: ${unsuppressed.length} finding${unsuppressed.length === 1 ? '' : 's'} (${formatSummaryLine(it.summary)}): ${unsuppressed.slice(0, 5).map((f) => `${mdCell(f.file)}${f.line ? ':' + f.line : ''} ${mdCell(f.message)}`).join('; ')}${unsuppressed.length > 5 ? '; ...' : ''}.`);
    lines.push('');
  }
  const tree = receipt.tree.slice(0, 7);
  const where = receipt.head ? `Tree ${tree} on ${receipt.branch ?? 'detached'}@${receipt.head.slice(0, 7)}${receipt.dirtyFiles ? ` (+${receipt.dirtyFiles} uncommitted)` : ' (clean)'}` : `Tree ${tree}`;
  const label = state === 'PASS' && receipt.profile === 'lite' ? 'PASS (lite: typecheck/lint only, tests not run)' : state;
  lines.push(`${where}. Receipt: **${label}**${receipt.host ? ` · Agent: ${receipt.host}` : ''} · isitdone ${VERSION} · ${receipt.createdAt}`);
  return lines.join('\n');
}

/** Full markdown report for CI: verdict, checks, integrity findings, tree. */
export function formatReportMarkdown(res: VerifyResult, state: string): string {
  const lines: string[] = [];
  const failed = res.ran.filter((r) => r.status !== 'PASS');
  const blocked = integrityBlocks(res);
  const verdict = res.ok && !blocked ? 'DONE' : 'NOT DONE';
  const why = !res.ok ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed` : blocked ? `checks pass, but ${res.integrity?.blocking.length} test-integrity finding${res.integrity?.blocking.length === 1 ? '' : 's'} block${res.integrity?.blocking.length === 1 ? 's' : ''}` : res.detection.checks.length === 0 ? 'no checks detected' : `${res.ran.length || res.receipt?.checks.length || 0} checks passed`;
  lines.push(`**${verdict}** (${why})`);
  lines.push('');
  const checks = res.cached && res.receipt ? res.receipt.checks : res.ran;
  if (checks.length > 0) {
    lines.push('| check | result | time |');
    lines.push('|---|---|---|');
    for (const r of checks) {
      const d = detail(r);
      lines.push(`| \`${mdCell(r.cmd)}\` | ${statusWord(r)}${d ? ` (${mdCell(d)})` : ''} | ${formatDuration(r.durationMs)} |`);
    }
    for (const sk of res.skipped) lines.push(`| \`${mdCell(sk.check.cmd)}\` | SKIP (${mdCell(sk.reason)}) | |`);
    lines.push('');
  } else if (res.detection.checks.length === 0) {
    lines.push('No checks detected: add a test script to `package.json` or define checks in `.isitdone.json`.');
    lines.push('');
  }
  for (const r of failed) {
    lines.push(`<details><summary><code>${mdCell(r.cmd)}</code> output (last ${Math.min(r.tail.length, 30)} lines)</summary>`);
    lines.push('');
    lines.push('```');
    for (const l of r.tail.slice(-30)) lines.push(l.replace(/```/g, "'''"));
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  const it = res.integrity;
  if (it && (it.testFiles > 0 || it.findings.length > 0)) {
    lines.push(`**Test integrity** (${formatSummaryLine(it.summary)}${res.integrityMode === 'strict' ? ', strict' : ''})`);
    lines.push('');
    if (it.findings.length === 0) lines.push(`${it.testFiles} test file${it.testFiles === 1 ? '' : 's'} changed, nothing weakened.`);
    else {
      lines.push('| where | finding | severity |');
      lines.push('|---|---|---|');
      for (const f of it.findings.slice(0, 40)) lines.push(`| \`${mdCell(f.file)}${f.line ? ':' + f.line : ''}\` | ${mdCell(f.message)}${f.suppressed ? ` (allowed: ${mdCell(f.suppressed)})` : ''} | ${f.severity} |`);
      if (it.findings.length > 40) lines.push(`| | ... ${it.findings.length - 40} more | |`);
    }
    lines.push('');
  }
  for (const w of res.warnings) lines.push(`> warning: ${w}`);
  if (res.warnings.length) lines.push('');
  const g = res.git;
  const tree = g.tree.slice(0, 7);
  lines.push(`<sub>Tree ${tree}${g.head ? ` on ${g.branch ?? 'detached'}@${g.head.slice(0, 7)}` : ''}${g.dirtyFiles ? ` (+${g.dirtyFiles} uncommitted)` : ''} · receipt ${state} · isitdone ${VERSION}</sub>`);
  return lines.join('\n');
}

/** The receipt a run wrote or reused: PASS, FAIL, or NONE when nothing was written (no checks, doctor mode, cancelled). */
export function receiptStateOf(res: VerifyResult): 'PASS' | 'FAIL' | 'NONE' {
  return res.receipt ? (res.receipt.status === 'PASS' ? 'PASS' : 'FAIL') : res.cached ? 'PASS' : 'NONE';
}

/** Stable machine-readable summary. */
export function toJson(res: VerifyResult, state: string): Record<string, unknown> {
  const checks = res.cached && res.receipt ? res.receipt.checks : res.ran;
  const noChecks = res.detection.checks.length === 0;
  const fullPass = res.ok && !noChecks && (res.cached ? res.receipt?.profile === 'full' : res.profile === 'full' && res.receipt?.profile === 'full');
  return {
    ok: res.ok && !integrityBlocks(res),
    // done is true only when every full check passed on this exact tree. No checks detected is not "done".
    done: Boolean(fullPass) && !integrityBlocks(res),
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
    integrity: res.integrity
      ? {
          mode: res.integrityMode,
          summary: res.integrity.summary,
          testFiles: res.integrity.testFiles,
          findings: res.integrity.findings,
          blocking: res.integrity.blocking.length,
        }
      : null,
    stacks: res.detection.stacks,
    notes: res.detection.notes,
    warnings: res.warnings,
    receipt: res.receipt ? { createdAt: res.receipt.createdAt, status: res.receipt.status, profile: res.receipt.profile, tree: res.receipt.tree } : null,
    durationMs: res.durationMs,
    version: VERSION,
  };
}

export type { IntegrityReport };
