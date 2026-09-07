import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectChecks } from './detect.js';
import { loadConfig } from './config.js';
import { gitInfo } from './git.js';
import { installedHooks } from './init.js';
import type { HostAdapter } from './hosts.js';
import { childEnv, killTree } from './run.js';
import { isNewer, latestVersion } from './update.js';
import { budgetSeconds, timeoutFor } from './verify.js';
import { VERSION } from './version.js';

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
  /** Milliseconds to wait for a hook probe. Default 90s (npx cold start can be slow). */
  probeTimeoutMs?: number;
  /** Ask the registry whether a newer release exists. Default true; silently skipped offline. */
  checkLatest?: boolean;
}

interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Run the registered hook command with a synthetic "tests pass" stop event. ISITDONE_DOCTOR=1 makes the hook run only
 * an injected failing probe (no real checks, nothing persisted), so this proves the plumbing, not the test suite.
 */
export function probeHook(command: string, host: HostAdapter, root: string, timeoutMs: number, message = 'Done. All tests pass and the feature is complete.'): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const env = childEnv();
    delete env.ISITDONE; // the probe is not a nested check
    env.ISITDONE_DOCTOR = '1';
    const child = spawn(command, {
      cwd: root,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
    };
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      setTimeout(() => finish(null), 2000);
    }, timeoutMs);
    child.on('error', (err) => {
      stderr += err.message;
      finish(null);
    });
    child.on('exit', (code) => setTimeout(() => finish(code), 300));
    child.on('close', (code) => finish(code));
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

function gitignoreCoversState(root: string): boolean {
  const own = join(root, '.isitdone', '.gitignore');
  if (existsSync(own) && readFileSync(own, 'utf8').trim() === '*') return true;
  const gi = join(root, '.gitignore');
  if (!existsSync(gi)) return false;
  return readFileSync(gi, 'utf8').split(/\r?\n/).some((l) => /^\/?\.isitdone\/?$/.test(l.trim()));
}

export async function doctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const root = opts.root;
  const probeTimeout = opts.probeTimeoutMs ?? 90_000;

  // git
  const git = gitInfo(root);
  if (!git.isRepo) {
    checks.push({ name: 'git', ok: false, detail: 'not a git repository', hint: 'isitdone binds receipts to the git tree; without git every receipt is STALE and nothing is cached.' });
  } else if (git.tree === 'unknown') {
    checks.push({ name: 'git', ok: false, detail: `working tree could not be hashed: ${git.treeError ?? 'unknown git error'}`, hint: 'receipts cannot be cached until this is fixed; the checks still run.' });
  } else {
    checks.push({ name: 'git', ok: true, detail: `${git.branch ?? 'detached'}@${git.headShort ?? 'no commits'}, ${git.dirtyFiles} dirty file(s), tree ${git.tree.slice(0, 7)}` });
  }

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
  if (!hooks.some((h) => h.event === 'stop')) {
    checks.push({ name: 'hooks', ok: false, detail: 'no isitdone hook installed', hint: 'run `npx isitdone init` (add --agent codex|cursor|gemini|all for other hosts).' });
  }
  const budget = budgetSeconds(detection.checks, config);
  for (const h of hooks) {
    if (h.event === 'edit') {
      checks.push({ name: `edit-hook:${h.host.name}`, ok: true, detail: `${h.host.displayName} ${h.host.edit?.event ?? ''} (${h.scope}) -> ${h.command}` });
      continue;
    }
    checks.push({ name: `hook:${h.host.name}`, ok: true, detail: `${h.host.displayName} (${h.scope}) ${h.path} -> ${h.command}` });
    if (h.timeout !== null && budget > h.timeout) {
      checks.push({ name: `timeout:${h.host.name}`, ok: false, detail: `hook timeout ${h.timeout}s is smaller than the worst case of the checks (${budget}s)`, hint: 'a hook that overruns is cancelled by the host and the stop is allowed; re-run `init` to resize it, or lower the check timeouts.' });
    }
    if (opts.probeHooks ?? true) {
      const probe = await probeHook(h.command, h.host, root, probeTimeout);
      const verdict = looksBlocked(h.host, probe);
      if (verdict.blocked) {
        const hookVersion = /\[isitdone ([^\]\s]+)\]/.exec(probe.stdout + probe.stderr)?.[1] ?? null;
        checks.push({ name: `probe:${h.host.name}`, ok: true, detail: `synthetic "tests pass" stop was blocked in ${(probe.durationMs / 1000).toFixed(1)}s (${verdict.reason})${hookVersion ? `, hook runs isitdone ${hookVersion}` : ''}` });
        if (hookVersion && hookVersion !== VERSION && isNewer(VERSION, hookVersion)) {
          checks.push({ name: `stale:${h.host.name}`, ok: false, detail: `the hook runs isitdone ${hookVersion} but this CLI is ${VERSION}`, hint: 'npx caches the hook package separately; run `npx isitdone update` to refresh it.' });
        }
      } else if (probe.timedOut) {
        checks.push({ name: `probe:${h.host.name}`, ok: false, detail: `hook did not answer within ${probeTimeout / 1000}s`, hint: 'first npx run downloads the package; run `npx -y @aivolution/isitdone --version` once, or `npm i -D @aivolution/isitdone` so the hook resolves locally.' });
      } else {
        const tail = (probe.stderr || probe.stdout).trim().split('\n').slice(-3).join(' | ');
        checks.push({ name: `probe:${h.host.name}`, ok: false, detail: `hook did not block (${verdict.reason}; exit ${probe.exitCode ?? 'n/a'}) ${tail}`.trim(), hint: 'check that the command in the settings file runs from a shell in this directory.' });
      }
    }
    if (h.host.postInstallNote) checks.push({ name: `note:${h.host.name}`, ok: true, detail: h.host.postInstallNote });
  }

  // gitignore
  if (git.isRepo && !gitignoreCoversState(root)) {
    checks.push({ name: 'gitignore', ok: false, detail: '.isitdone/ is not ignored by git', hint: 'receipts and keys are local state; `init` adds the rule, or add ".isitdone/" to .gitignore.' });
  }

  // newer release available? (skipped silently when offline)
  if (opts.checkLatest ?? true) {
    const latest = latestVersion();
    if (latest && isNewer(latest, VERSION)) {
      checks.push({ name: 'version', ok: true, detail: `this is isitdone ${VERSION}; ${latest} is available (run \`npx isitdone update\`)` });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
