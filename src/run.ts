import { spawn, spawnSync } from 'node:child_process';
import { stripAnsi } from './output.js';
import type { Check } from './detect.js';

export type CheckStatus = 'PASS' | 'FAIL' | 'TIMEOUT' | 'ERROR';

export interface RunResult {
  id: string;
  cmd: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  /** Timeout that applied, in ms (for TIMEOUT wording). */
  timeoutMs: number;
  /** Last lines of combined stdout+stderr, ANSI-stripped. */
  tail: string[];
  /** Total number of output lines seen. */
  lines: number;
  /** A one-line summary extracted from the output when recognisable (e.g. "2 failed, 45 passed"). */
  summary?: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** How many trailing lines to keep. Default 30. */
  tailLines?: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
}

/** Longest partial line kept in memory; progress bars without newlines are truncated from the left. */
const MAX_LINE = 64 * 1024;
/** After the process exits, how long to wait for stdio to drain before finishing anyway. */
const EXIT_GRACE_MS = 400;
/** After a timeout kill, how long to wait for 'close' before finishing anyway. */
const KILL_GRACE_MS = 2000;

class Tail {
  private buf: string[] = [];
  private partial = '';
  lines = 0;
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    let text = this.partial + chunk;
    // A trailing bare CR might be the first half of CRLF split across chunks: hold it.
    let hold = '';
    if (text.endsWith('\r')) {
      hold = '\r';
      text = text.slice(0, -1);
    }
    const parts = text.split('\n');
    let last = (parts.pop() ?? '') + hold;
    for (const p of parts) this.add(this.lastSegment(p));
    // A bare CR inside the partial means "overwrite this line": keep only the newest segment.
    last = this.lastSegment(last.endsWith('\r') ? last.slice(0, -1) : last) + (last.endsWith('\r') ? '\r' : '');
    this.partial = last.length > MAX_LINE ? last.slice(-MAX_LINE) : last;
  }
  private lastSegment(line: string): string {
    const withoutCrlf = line.endsWith('\r') ? line.slice(0, -1) : line;
    const i = withoutCrlf.lastIndexOf('\r');
    return i >= 0 ? withoutCrlf.slice(i + 1) : withoutCrlf;
  }
  private add(line: string): void {
    this.lines++;
    this.buf.push(line.length > MAX_LINE ? line.slice(-MAX_LINE) : line);
    if (this.buf.length > this.max) this.buf.shift();
  }
  finish(): string[] {
    const rest = this.partial.endsWith('\r') ? this.partial.slice(0, -1) : this.partial;
    if (rest !== '') this.add(this.lastSegment(rest));
    this.partial = '';
    return this.buf.map((l) => stripAnsi(l).replace(/\s+$/, ''));
  }
}

function posixDescendants(root: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return [];
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop() as number;
    for (const c of children.get(p) ?? []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

/**
 * Kill a process and everything it spawned. The check is NOT put in its own process group, so a host
 * that kills the hook's group takes the check down with it; for our own timeouts we walk the tree.
 */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      return;
    }
    const descendants = posixDescendants(pid);
    for (const p of descendants.reverse()) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // gone
      }
    }
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

const SUMMARY_PATTERNS: RegExp[] = [
  /\bTests:\s+.*$/i, // jest "Tests: 1 failed, 2 passed"
  /\bTest Files\s+.*$/i, // vitest
  /\btest result: .*$/i, // cargo
  /\b\d+ (?:failed|passed|skipped|pending|todo)(?:,\s*\d+ (?:failed|passed|skipped|pending|todo))*\b.*$/i, // jest/vitest/pytest style
  /^(?:FAIL|ok|---\s*FAIL)\b.*$/m, // go test
  /\bFound \d+ errors? in \d+ files?\.?/i, // tsc
  /\berror TS\d+:.*$/, // tsc single error
  /\b\d+ problems? \(\d+ errors?, \d+ warnings?\)/i, // eslint
  /\bFound \d+ errors?\b.*$/i, // ruff/mypy
  /\bSuccess: no issues found\b.*$/i, // mypy
  /\ball checks passed!?/i, // ruff
  /\bPassed!\s+-\s+Failed:\s+\d+.*$/i, // dotnet
  /\bFailed!\s+-\s+Failed:\s+\d+.*$/i, // dotnet
  /\bBUILD (?:SUCCESSFUL|FAILED|SUCCESS|FAILURE)\b.*$/i, // gradle/maven
];

export function extractSummary(tail: string[]): string | undefined {
  // node --test prints "ℹ pass N" / "ℹ fail N" lines at the end.
  let nodePass: string | undefined;
  let nodeFail: string | undefined;
  for (const line of tail) {
    const p = /^\s*(?:ℹ|i)?\s*pass\s+(\d+)\s*$/.exec(line);
    const f = /^\s*(?:ℹ|i)?\s*fail\s+(\d+)\s*$/.exec(line);
    if (p) nodePass = p[1];
    if (f) nodeFail = f[1];
  }
  if (nodePass !== undefined && nodeFail !== undefined) return `${nodeFail} failed, ${nodePass} passed`;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i] as string;
    for (const re of SUMMARY_PATTERNS) {
      const m = re.exec(line);
      if (m) return m[0].trim().slice(0, 120);
    }
  }
  return undefined;
}

export function childEnv(base: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra, ISITDONE: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  if (env.CI === undefined) env.CI = 'true';
  return env;
}

export function runCheck(check: Check, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const tail = new Tail(opts.tailLines ?? 30);
  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const child = spawn(check.cmd, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? childEnv(),
      windowsHide: true,
      detached: false,
    });

    const onData = (d: Buffer) => {
      const s = d.toString('utf8');
      tail.push(s);
      opts.onOutput?.(s);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const done = (status: CheckStatus, exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      // A grandchild may still hold the pipes open: release them so the event loop can drain.
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      const lines = tail.finish();
      const result: RunResult = {
        id: check.id,
        cmd: check.cmd,
        status,
        exitCode,
        durationMs: Date.now() - started,
        timeoutMs: opts.timeoutMs,
        tail: lines,
        lines: tail.lines,
      };
      const summary = extractSummary(lines);
      if (summary) result.summary = summary;
      resolve(result);
    };

    const settle = () => {
      if (timedOut) return done('TIMEOUT', exited?.code ?? null);
      if (!exited) return done('ERROR', null);
      if (exited.code === 0) return done('PASS', 0);
      if (exited.signal) tail.push(`(terminated by ${exited.signal})\n`);
      done('FAIL', exited.code);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      // If the kill cannot reach a re-parented grandchild, 'close' never fires; finish anyway.
      killTimer = setTimeout(settle, KILL_GRACE_MS);
    }, opts.timeoutMs);

    child.on('error', (err) => {
      tail.push(`${err.message}\n`);
      done('ERROR', null);
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      // Give stdio a moment to drain, then finish even if a leftover process keeps the pipes open.
      graceTimer = setTimeout(settle, EXIT_GRACE_MS);
    });
    child.on('close', (code, signal) => {
      if (!exited) exited = { code, signal };
      settle();
    });
  });
}
