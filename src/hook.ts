import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findClaim } from './claims.js';
import { loadConfig, type IsitdoneConfig } from './config.js';
import { findRoot, RECEIPT_DIR } from './git.js';
import { getHost, type HookInput, type HostAdapter } from './hosts.js';
import { ensureStateDir } from './receipt.js';
import { formatBlockReason } from './report.js';
import { verify, type ResolvedProfile, type VerifyResult } from './verify.js';

export const DEFAULT_MAX_ATTEMPTS = 3;
/** Claude Code caps hook output at 10,000 characters. */
const MAX_REASON_CHARS = 9000;
const STATE_FILE = 'session.json';

export interface SessionState {
  sessionId: string | null;
  attempts: number;
  lastTree: string | null;
  updatedAt: string;
}

export interface HookOutcome {
  /** What to write to stdout. */
  stdout: string;
  /** What to write to stderr (diagnostics only; hosts ignore it on exit 0). */
  stderr: string;
  exitCode: number;
  decision: 'allow' | 'block';
  /** Why we decided that, for humans and tests. */
  why: string;
  result: VerifyResult | null;
  attempts: number;
}

export interface HookOptions {
  host: string;
  /** Raw stdin text. */
  stdin: string;
  /** Fallback directory when the payload has none. */
  cwd?: string;
  /** Doctor mode: inject a failing check, never persist receipts or state. */
  doctor?: boolean;
  /** Override the configured profile. */
  profile?: 'claim-gated' | 'lite' | 'full';
  env?: NodeJS.ProcessEnv;
}

export function readState(root: string): SessionState | null {
  const f = join(root, RECEIPT_DIR, STATE_FILE);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}

export function writeState(root: string, state: SessionState): void {
  const d = ensureStateDir(root);
  writeFileSync(join(d, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

export function parsePayload(stdin: string): Record<string, unknown> | null {
  const text = (stdin.charCodeAt(0) === 0xfeff ? stdin.slice(1) : stdin).trim();
  if (text === '' || !text.startsWith('{')) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function resolveProfile(config: IsitdoneConfig, input: HookInput, override?: 'claim-gated' | 'lite' | 'full'): { profile: ResolvedProfile; claim: string | null; why: string } {
  const claim = findClaim(input.lastMessage, config.claimPatterns ?? []);
  const setting = override ?? config.profile ?? 'claim-gated';
  if (setting === 'full') return { profile: 'full', claim: claim?.sentence ?? null, why: 'profile is full' };
  if (setting === 'lite') return { profile: 'lite', claim: claim?.sentence ?? null, why: 'profile is lite' };
  if (input.lastMessage === null) return { profile: 'full', claim: null, why: 'host did not provide the final message; running full checks (cached per tree)' };
  if (claim) return { profile: 'full', claim: claim.sentence, why: `completion claim detected (${claim.pattern})` };
  return { profile: 'lite', claim: null, why: 'no completion claim in the final message' };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 20) + '\n... (truncated)';
}

/**
 * Decide whether the agent may stop. Pure with respect to process globals: reads stdin text and
 * returns what to print and which exit code to use.
 */
export async function runHook(opts: HookOptions): Promise<HookOutcome> {
  const host: HostAdapter = getHost(opts.host);
  const doctor = opts.doctor ?? false;
  const allow = (why: string, systemMessage?: string, result: VerifyResult | null = null, attempts = 0): HookOutcome => ({
    stdout: host.allow(systemMessage),
    stderr: '',
    exitCode: 0,
    decision: 'allow',
    why,
    result,
    attempts,
  });

  const raw = parsePayload(opts.stdin);
  if (!raw) return allow('stdin was not a JSON object (host bug or manual run); allowing');
  const input = host.parse(raw);

  if (input.status !== null && input.status !== 'completed') return allow(`host status is ${input.status}; nothing to verify`);
  if (input.backgroundTasks > 0) return allow(`${input.backgroundTasks} background task(s) still running; this stop is a pause, not completion`);

  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : (opts.cwd ?? process.cwd());
  const root = findRoot(cwd);

  let config: IsitdoneConfig;
  try {
    config = loadConfig(root).config;
  } catch (err) {
    // A broken config must not brick the agent; surface it to the user instead.
    return allow(`config error: ${(err as Error).message}`, `isitdone: ${(err as Error).message}`);
  }
  if (doctor) {
    config = { ...config, checks: { ...(config.checks ?? {}), 'doctor-probe': { cmd: 'node -e "console.log(\'isitdone doctor: simulated failing check\'); process.exit(1)"', kind: 'lite' } } };
  }
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const prev = readState(root);
  let attempts = prev && prev.sessionId === input.sessionId ? prev.attempts : 0;
  // A stop that is NOT a continuation of a stop-hook block starts a fresh turn.
  if (!input.stopHookActive) attempts = 0;

  if (input.stopHookActive && attempts >= maxAttempts) {
    return allow(`already blocked ${attempts} time(s) this turn (max ${maxAttempts}); letting the agent stop`, `isitdone: checks still failing after ${attempts} attempts; allowing the agent to stop. Run \`npx isitdone\` to see what is failing.`, null, attempts);
  }

  const { profile, claim, why } = resolveProfile(config, input, opts.profile);

  const result = await verify({
    root,
    config,
    profile,
    claim,
    host: host.name === 'claude' ? 'claude-code' : host.name === 'gemini' ? 'gemini-cli' : host.name,
    useCache: !doctor,
    dryRun: doctor,
  });

  if (result.ok) {
    if (!doctor) writeState(root, { sessionId: input.sessionId, attempts: 0, lastTree: result.git.tree, updatedAt: new Date().toISOString() });
    return allow(`${result.cached ? 'cached PASS' : profile === 'full' ? 'all checks passed' : 'lite checks passed'} (${why})`, undefined, result, 0);
  }

  attempts += 1;
  if (!doctor) writeState(root, { sessionId: input.sessionId, attempts, lastTree: result.git.tree, updatedAt: new Date().toISOString() });
  if (attempts > maxAttempts) {
    return allow(`checks failed but attempts (${attempts}) exceed max (${maxAttempts}); letting the agent stop`, `isitdone: checks still failing after ${attempts - 1} attempts; allowing the agent to stop. Run \`npx isitdone\` to see what is failing.`, result, attempts);
  }
  const reason = truncate(formatBlockReason(result, attempts, maxAttempts), MAX_REASON_CHARS);
  return {
    stdout: host.block(reason),
    stderr: '',
    exitCode: 0,
    decision: 'block',
    why: `${result.ran.filter((r) => r.status !== 'PASS').length} check(s) failed (${why})`,
    result,
    attempts,
  };
}

export function readStdin(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      data += c;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}
