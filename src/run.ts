import { spawn } from 'node:child_process';
import { stripAnsi } from './output.js';
import type { Check } from './detect.js';

export type CheckStatus = 'PASS' | 'FAIL' | 'TIMEOUT' | 'ERROR';

export interface RunResult {
  id: string;
  cmd: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
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

class Tail {
  private buf: string[] = [];
  private partial = '';
  lines = 0;
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    const text = this.partial + chunk;
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    for (const p of parts) this.add(p);
  }
  private add(line: string): void {
    this.lines++;
    this.buf.push(line);
    if (this.buf.length > this.max) this.buf.shift();
  }
  finish(): string[] {
    if (this.partial !== '') {
      this.add(this.partial);
      this.partial = '';
    }
    return this.buf.map((l) => stripAnsi(l).replace(/\s+$/, ''));
  }
}

/** Kill a process and everything it spawned. */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
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

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ISITDONE: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  if (env.CI === undefined) env.CI = 'true';
  return env;
}

export function runCheck(check: Check, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const tail = new Tail(opts.tailLines ?? 30);
  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    const child = spawn(check.cmd, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? childEnv(),
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const onData = (d: Buffer) => {
      const s = d.toString('utf8');
      tail.push(s);
      opts.onOutput?.(s);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs);
    const done = (status: CheckStatus, exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const lines = tail.finish();
      const result: RunResult = {
        id: check.id,
        cmd: check.cmd,
        status,
        exitCode,
        durationMs: Date.now() - started,
        tail: lines,
        lines: tail.lines,
      };
      const summary = extractSummary(lines);
      if (summary) result.summary = summary;
      resolve(result);
    };
    child.on('error', (err) => {
      tail.push(`${err.message}\n`);
      done('ERROR', null);
    });
    child.on('close', (code, signal) => {
      if (timedOut) return done('TIMEOUT', code);
      if (code === 0) return done('PASS', 0);
      if (signal) tail.push(`(terminated by ${signal})\n`);
      done('FAIL', code);
    });
  });
}
