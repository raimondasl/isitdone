import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { detectChecks } from './detect.js';
import { loadConfig } from './config.js';
import { gitInfo } from './git.js';
import { installedHooks } from './init.js';
import type { HostAdapter } from './hosts.js';
import { childEnv } from './run.js';
import { timeoutFor } from './verify.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Advice when not ok, or a note when ok. */
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  root: string;
  /** Run each registered hook command with a synthetic payload. Default true. */
  probeHooks?: boolean;
  /** Milliseconds to wait for a hook probe. Default 60s (npx cold start can be slow). */
  probeTimeoutMs?: number;
}

interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export function probeHook(command: string, host: HostAdapter, root: string, timeoutMs: number, message = 'Done. All tests pass and the feature is complete.'): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...childEnv(), ISITDONE_DOCTOR: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + err.message, durationMs: Date.now() - started, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
    child.stdin?.end(JSON.stringify(host.synthetic(root, message)));
  });
}

/** Did the probe output look like a block for this host? */
export function looksBlocked(host: HostAdapter, probe: ProbeResult): { blocked: boolean; reason: string } {
  if (probe.exitCode === 2 && probe.stderr.trim() !== '') return { blocked: true, reason: 'exit 2 with stderr' };
  const text = probe.stdout.trim();
  if (!text.startsWith('{')) return { blocked: false, reason: text === '' ? 'no output' : `non-JSON stdout: ${text.slice(0, 80)}` };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { blocked: false, reason: 'stdout is not valid JSON' };
  }
  if (host.name === 'cursor') return typeof json.followup_message === 'string' && json.followup_message !== '' ? { blocked: true, reason: 'followup_message present' } : { blocked: false, reason: 'no followup_message' };
  if (host.name === 'gemini') return json.decision === 'deny' || json.decision === 'block' ? { blocked: true, reason: `decision ${String(json.decision)}` } : { blocked: false, reason: 'decision is not deny' };
  return json.decision === 'block' && typeof json.reason === 'string' && json.reason !== '' ? { blocked: true, reason: 'decision block with reason' } : { blocked: false, reason: 'decision is not block' };
}

export async function doctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const root = opts.root;

  // git
  const git = gitInfo(root);
  checks.push(
    git.isRepo
      ? { name: 'git', ok: true, detail: `${git.branch ?? 'detached'}@${git.headShort ?? 'no commits'}, ${git.dirtyFiles} dirty file(s), tree ${git.tree.slice(0, 7)}` }
      : { name: 'git', ok: false, detail: 'not a git repository', hint: 'isitdone binds receipts to the git tree; without git every receipt is STALE and nothing is cached.' },
  );

  // config + detection
  let config = {};
  let configSource: string | null = null;
  try {
    const loaded = loadConfig(root);
    config = loaded.config;
    configSource = loaded.source;
    checks.push({ name: 'config', ok: true, detail: configSource ? `loaded ${configSource}` : 'no .isitdone.json (auto-detect only)' });
  } catch (err) {
    checks.push({ name: 'config', ok: false, detail: (err as Error).message });
  }
  const detection = detectChecks(root, config);
  if (detection.checks.length === 0) {
    checks.push({ name: 'checks', ok: false, detail: 'no checks detected', hint: 'add scripts to package.json or define checks in .isitdone.json; until then the hook allows every stop.' });
  } else {
    const lines = detection.checks.map((c) => `${c.id}: ${c.cmd} [${c.kind}, ${timeoutFor(c, config) / 1000}s]`);
    checks.push({ name: 'checks', ok: true, detail: lines.join('; ') });
  }
  for (const n of detection.notes) checks.push({ name: 'note', ok: true, detail: n });

  // hooks
  const hooks = installedHooks(root);
  if (hooks.length === 0) {
    checks.push({ name: 'hooks', ok: false, detail: 'no isitdone hook installed', hint: 'run `npx isitdone init` (add --agent codex|cursor|gemini|all for other hosts).' });
  }
  for (const h of hooks) {
    checks.push({ name: `hook:${h.host.name}`, ok: true, detail: `${h.host.displayName} (${h.scope}) ${h.path} -> ${h.command}` });
    if (opts.probeHooks ?? true) {
      const probe = await probeHook(h.command, h.host, root, opts.probeTimeoutMs ?? 60_000);
      const verdict = looksBlocked(h.host, probe);
      if (probe.timedOut) {
        checks.push({ name: `probe:${h.host.name}`, ok: false, detail: `hook did not finish within ${(opts.probeTimeoutMs ?? 60_000) / 1000}s`, hint: 'first npx run downloads the package; run `npx -y isitdone --version` once, or `npm i -D isitdone` to make it local.' });
      } else if (verdict.blocked) {
        checks.push({ name: `probe:${h.host.name}`, ok: true, detail: `synthetic "tests pass" stop was blocked in ${(probe.durationMs / 1000).toFixed(1)}s (${verdict.reason})` });
      } else {
        const tail = (probe.stderr || probe.stdout).trim().split('\n').slice(-3).join(' | ');
        checks.push({ name: `probe:${h.host.name}`, ok: false, detail: `hook did not block (${verdict.reason}; exit ${probe.exitCode ?? 'n/a'}) ${tail}`.trim(), hint: 'check that the command in the settings file runs from a shell in this directory.' });
      }
    }
    if (h.host.postInstallNote) checks.push({ name: `note:${h.host.name}`, ok: true, detail: h.host.postInstallNote });
  }

  // gitignore
  const gi = `${root}/.gitignore`;
  if (git.isRepo && existsSync(gi)) {
    const { readFileSync } = await import('node:fs');
    const ignored = readFileSync(gi, 'utf8').split(/\r?\n/).some((l) => /^\/?\.isitdone\/?$/.test(l.trim()));
    if (!ignored) checks.push({ name: 'gitignore', ok: false, detail: '.isitdone/ is not in .gitignore', hint: 'receipts and keys are local state; `npx isitdone init` adds the rule.' });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
