import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findClaim } from './claims.js';
import { loadConfig, type IsitdoneConfig } from './config.js';
import { detectChecks } from './detect.js';
import { collectDiff, type DiffResult } from './diff.js';
import { checkEditedFile, insideRepo, toRepoPath } from './editcheck.js';
import { tryReadJsonFile, writeFileAtomic } from './fsutil.js';
import { dirtyPathSet, findRoot, gitTopLevel, RECEIPT_DIR } from './git.js';
import { getHost, type HookInput, type HostAdapter, type HostName } from './hosts.js';
import { ensureStateDir } from './receipt.js';
import { formatBlockReason, integrityBlocks, type OtherSessionNote } from './report.js';
import { acquireRunLock, attribute, formatAgo, mentions, recordEdits, sessionKey, SESSIONS_DIR, type Attribution } from './sessions.js';
import { verify, type ResolvedProfile, type VerifyResult } from './verify.js';

export const DEFAULT_MAX_ATTEMPTS = 3;
/** Claude Code caps hook output at 10,000 characters. */
const MAX_REASON_CHARS = 9000;
const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How the host is named in receipts (kept stable; older receipts already carry these). */
const RECEIPT_HOST: Partial<Record<HostName, string>> = { claude: 'claude-code', gemini: 'gemini-cli', copilot: 'copilot-cli', qwen: 'qwen-code', junie: 'junie-cli', augment: 'auggie' };
/** Tool events a stop-hook command may receive when a custom wrapper does not forward `--event edit`. */
const EDIT_EVENT = /^(?:PostToolUse|AfterTool|afterFileEdit|tool\.execute\.after)$/i;

export interface SessionState {
  host: string;
  sessionId: string | null;
  turnId: string | null;
  attempts: number;
  /** Cursor: loop_count seen at the last stop. */
  loopCount: number | null;
  lastTree: string | null;
  /**
   * Attempts allowed for this turn when it is lower than maxAttempts: 1 while another session is editing the same
   * working tree and the failure cannot be tied to this session's files.
   */
  cap?: number | null;
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
  /** Doctor mode: run only an injected failing check, never persist receipts or state. */
  doctor?: boolean;
  /** Override the configured profile. */
  profile?: 'claim-gated' | 'lite' | 'full';
  env?: NodeJS.ProcessEnv;
}

function stateFile(root: string, host: string, sessionId: string | null): string {
  return join(root, RECEIPT_DIR, SESSIONS_DIR, `${sessionKey(host, sessionId)}.json`);
}

export function readState(root: string, host: string, sessionId: string | null): SessionState | null {
  return tryReadJsonFile<SessionState>(stateFile(root, host, sessionId));
}

/** Returns false when the state could not be persisted (the loop guard then cannot be trusted). */
export function writeState(root: string, state: SessionState): boolean {
  try {
    ensureStateDir(root);
    writeFileAtomic(stateFile(root, state.host, state.sessionId), JSON.stringify(state, null, 2) + '\n');
    pruneStates(root);
    return true;
  } catch {
    return false;
  }
}

function pruneStates(root: string): void {
  const dir = join(root, RECEIPT_DIR, SESSIONS_DIR);
  try {
    const now = Date.now();
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      try {
        if (now - statSync(p).mtimeMs > STATE_MAX_AGE_MS) rmSync(p, { force: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
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

/**
 * Is this stop a continuation of our own block in the same turn?
 * Hosts with stop_hook_active say so directly. Cursor only has a per-conversation loop_count, so a continuation is
 * "loop_count advanced by exactly one since we last blocked". Hosts with no flag at all (Goose, Augment, Continue)
 * can only stop again right after our block because the agent kept going, so an unfinished block count means
 * continuation; runHook resets that count when it gives up, since the turn ends with that allow.
 */
export function isContinuation(input: HookInput, prev: SessionState | null): boolean {
  if (input.loopCount !== null && !input.stopHookActive) {
    return prev !== null && prev.loopCount !== null && prev.attempts > 0 && input.loopCount === prev.loopCount + 1;
  }
  if (input.stopHookActive === null) return prev !== null && prev.attempts > 0;
  return input.stopHookActive;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 20) + '\n... (truncated)';
}

/** Check output kept per check for working out whose files a failure names. */
const MAX_ATTRIBUTION_CHARS = 1024 * 1024;
const SHARED_TREE_NOTE = ' Another session is editing this working tree, so isitdone blocks only once when it cannot tell whose change broke a check.';

const GIVE_UP_MESSAGE = (n: number) => `isitdone: checks still failing after ${n} attempt${n === 1 ? '' : 's'}; allowing the agent to stop. Run \`npx isitdone\` to see what is failing.`;

/**
 * Decide whether the agent may stop. Pure with respect to process globals: reads stdin text and
 * returns what to print and which exit code to use.
 */
export async function runHook(opts: HookOptions): Promise<HookOutcome> {
  const host: HostAdapter = getHost(opts.host);
  const doctor = opts.doctor ?? false;
  const env = opts.env ?? process.env;
  const allow = (why: string, systemMessage?: string, result: VerifyResult | null = null, attempts = 0): HookOutcome => ({
    stdout: host.allow(systemMessage),
    stderr: '',
    exitCode: 0,
    decision: 'allow',
    why,
    result,
    attempts,
  });

  // A check that itself runs isitdone (e.g. a Makefile target) must not recurse.
  if (env.ISITDONE === '1') return allow('running nested inside an isitdone check; allowing');

  const raw = parsePayload(opts.stdin);
  if (!raw) return allow('stdin was not a JSON object (host bug or manual run); allowing');
  const input = host.parse(raw);

  // A custom --command wrapper that does not forward "--event edit" sends its tool events here too; those are warn-only.
  if (input.hookEventName && EDIT_EVENT.test(input.hookEventName)) {
    const e = runEditHook({ host: opts.host, stdin: opts.stdin, cwd: opts.cwd, env });
    return { stdout: e.stdout, stderr: '', exitCode: 0, decision: 'allow', why: `${input.hookEventName} payload routed to the edit hook: ${e.why}`, result: null, attempts: 0 };
  }

  if (input.status !== null && input.status !== 'completed') return allow(`host status is ${input.status}; nothing to verify`);
  if (input.permissionMode === 'plan') return allow('plan mode: the agent cannot edit files, so there is nothing to verify yet');

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
    // Doctor proves the plumbing: only the injected probe runs, and it always fails.
    if (input.stopHookActive) return allow('doctor mode never blocks twice');
    const disabled = Object.fromEntries(detectChecks(root, config).checks.map((c) => [c.id, false as const]));
    config = { ...config, checks: { ...disabled, 'doctor-probe': { cmd: 'node -e "console.log(\'isitdone doctor: simulated failing check\'); process.exit(1)"', kind: 'lite' } }, profile: 'full' };
  }
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const prev = doctor ? null : readState(root, host.name, input.sessionId);
  const continuation = isContinuation(input, prev);
  let attempts = continuation && prev ? prev.attempts : 0;

  // A block issued while another session was editing the tree may have lowered the cap for this turn.
  const cap = continuation && prev?.cap ? Math.min(prev.cap, maxAttempts) : maxAttempts;
  if (continuation && attempts >= cap) {
    // Record this stop so the next one (same loop_count on Cursor) counts as a new turn. Hosts without a flag start
    // counting again: the turn ends with this allow, so their next stop can only follow a new prompt.
    if (!doctor && prev) writeState(root, { ...prev, attempts: input.stopHookActive === null ? 0 : prev.attempts, loopCount: input.loopCount, turnId: input.turnId, updatedAt: new Date().toISOString() });
    const shared = cap < maxAttempts ? SHARED_TREE_NOTE : '';
    return allow(`already blocked ${attempts} time(s) this turn (max ${cap}); letting the agent stop`, GIVE_UP_MESSAGE(attempts) + shared, null, attempts);
  }

  const { profile, claim, why } = resolveProfile(config, input, opts.profile);

  // A stop with background tasks running and no completion claim is a pause, not "done".
  if (input.backgroundTasks > 0 && !claim && profile === 'lite') {
    return allow(`${input.backgroundTasks} background task(s) still running and no completion claim; treating this stop as a pause`);
  }

  // Two sessions stopping together must not run the suite on top of each other; after the wait, a PASS receipt the
  // other session just wrote for this exact tree is reused by verify().
  const lock = doctor ? null : await acquireRunLock(root);
  const output = new Map<string, string>();
  let result: VerifyResult;
  try {
    result = await verify({
      root,
      config,
      profile,
      claim,
      host: RECEIPT_HOST[host.name] ?? host.name,
      useCache: !doctor,
      dryRun: doctor,
      onOutput: doctor ? undefined : (check, chunk) => output.set(check.id, ((output.get(check.id) ?? '') + chunk).slice(-MAX_ATTRIBUTION_CHARS)),
    });
  } finally {
    lock?.release();
  }
  const state = (n: number, turnCap: number | null = null): SessionState => ({
    host: host.name,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attempts: n,
    loopCount: input.loopCount,
    lastTree: result.git.tree,
    cap: turnCap,
    updatedAt: new Date().toISOString(),
  });

  // Whose uncommitted files are these? Findings and failures in files another live session is editing are not this
  // session's to fix, and telling it to fix them makes it clobber the other session's work.
  const others = doctor || config.otherSessions === 'ignore' ? null : otherSessions(root, host.name, input.sessionId, result, output);
  const view = others ? setAsideForeignFindings(result, new Set(others.attribution.foreign.map((x) => x.path))) : result;

  const notes = [...view.warnings];
  if (lock && lock.waitedMs > 5000) notes.push(`waited ${Math.round(lock.waitedMs / 1000)} s for another session's check run in this directory${lock.held ? '' : ' and then ran alongside it'}`);
  const it = view.integrity;
  const weakened = it ? it.findings.filter((f) => !f.suppressed) : [];
  if (view.ok && weakened.length > 0 && !integrityBlocks(view)) {
    notes.push(`the change weakened tests (${weakened.length} finding${weakened.length === 1 ? '' : 's'}: ${weakened.slice(0, 3).map((f) => f.message).join('; ')}); run \`npx isitdone\` for details`);
  }
  const warn = notes.length ? `isitdone: ${notes.join('; ')}` : undefined;

  if (view.ok && !integrityBlocks(view)) {
    if (!doctor) writeState(root, state(0));
    return allow(`${view.cached ? 'cached PASS' : profile === 'full' ? 'all checks passed' : 'lite checks passed'} (${why})`, warn, view, 0);
  }

  const failedCount = view.ran.filter((r) => r.status !== 'PASS').length;
  // Tied to this session: the failing output names a file it edited, or its own test changes block in strict mode.
  const tiedToMe = others !== null && (others.mineNamed || integrityBlocks(view));
  if (others && others.foreignNamed.length > 0 && !tiedToMe) {
    if (!doctor) writeState(root, state(0));
    const names = others.foreignNamed.slice(0, 5).join(', ') + (others.foreignNamed.length > 5 ? ', ...' : '');
    const message = `isitdone: ${failedCount} check${failedCount === 1 ? '' : 's'} failed, but the output only names files another session is editing (${names}), so this session was not blocked. The receipt says FAIL; run \`npx isitdone\` once both sessions are finished.`;
    return allow(`${failedCount} check(s) failed only in files another session is editing (${why})`, warn ? `${message} (${warn})` : message, view, 0);
  }
  // Another session has work in progress here and nothing ties the failure to this session: block once, not three times.
  const turnCap = others && others.attribution.foreign.length > 0 && !tiedToMe ? 1 : maxAttempts;

  attempts += 1;
  if (!doctor && !writeState(root, state(attempts, turnCap < maxAttempts ? turnCap : null))) {
    // Without persisted state the attempts cap cannot work; blocking could loop forever.
    return allow('checks failed but session state could not be written; allowing to avoid an unbounded loop', `isitdone: checks failed but .isitdone/ is not writable, so the stop was allowed without enforcement. Run \`npx isitdone\` to see the failures.`, view, attempts);
  }
  if (attempts > turnCap) {
    if (!doctor) writeState(root, state(input.stopHookActive === null ? 0 : attempts, turnCap < maxAttempts ? turnCap : null));
    return allow(`checks failed but attempts (${attempts}) exceed max (${turnCap}); letting the agent stop`, GIVE_UP_MESSAGE(attempts - 1) + (turnCap < maxAttempts ? SHARED_TREE_NOTE : ''), view, attempts);
  }
  let reason = formatBlockReason(view, attempts, turnCap, others ? sessionNote(others.attribution) : null);
  if (warn) reason += `\n(${warn})`;
  return {
    stdout: host.block(truncate(reason, MAX_REASON_CHARS)),
    stderr: '',
    exitCode: 0,
    decision: 'block',
    why: `${failedCount} check(s) failed (${why})`,
    result: view,
    attempts,
  };
}

interface OtherSessions {
  attribution: Attribution;
  /** The failing output names a file this session edited. */
  mineNamed: boolean;
  /** Files of other live sessions that the failing output names. */
  foreignNamed: string[];
}

/** Null when no other live session has uncommitted edits here (the usual case), or on any error. */
function otherSessions(root: string, hostName: string, sessionId: string | null, result: VerifyResult, output: Map<string, string>): OtherSessions | null {
  if (!result.git.isRepo) return null;
  try {
    const attribution = attribute(root, hostName, sessionId, dirtyPathSet(result.git.root));
    if (attribution.foreign.length === 0 && attribution.shared.length === 0) return null;
    const prefix = relative(result.git.root, root).replace(/\\/g, '/');
    const rootPrefix = prefix && !prefix.startsWith('..') ? `${prefix}/` : '';
    const text = result.ran
      .filter((r) => r.status !== 'PASS')
      .map((r) => output.get(r.id) ?? r.tail.join('\n'))
      .join('\n')
      .replace(/\\/g, '/');
    const named = (p: string) => mentions(text, p, rootPrefix);
    return { attribution, mineNamed: [...attribution.mine].some(named), foreignNamed: attribution.foreign.map((x) => x.path).filter(named) };
  } catch {
    return null;
  }
}

/** Test-integrity findings in another session's files neither block this session nor get reported as its doing. */
function setAsideForeignFindings(result: VerifyResult, foreign: Set<string>): VerifyResult {
  const it = result.integrity;
  if (!it || foreign.size === 0 || !it.findings.some((f) => foreign.has(f.file) && !f.suppressed)) return result;
  const findings = it.findings.map((f) => (foreign.has(f.file) && !f.suppressed ? { ...f, suppressed: 'another session is editing this file' } : f));
  return { ...result, integrity: { ...it, findings, blocking: it.blocking.filter((f) => !foreign.has(f.file)) } };
}

function sessionNote(a: Attribution): OtherSessionNote {
  const now = Date.now();
  const list = (xs: Attribution['foreign']) => xs.map((x) => ({ path: x.path, ago: formatAgo(now - x.editedAt) }));
  return { foreign: list(a.foreign), shared: list(a.shared), lastActive: a.otherLastActive === null ? null : formatAgo(now - a.otherLastActive) };
}

export interface EditHookOutcome {
  stdout: string;
  why: string;
  notes: string[];
}

/**
 * Warn-only hook after the agent edits a file: scan the touched test/config files and hand the agent a short note.
 * Never blocks, never fails; exit code is always 0.
 */
export function runEditHook(opts: { host: string; stdin: string; cwd?: string; env?: NodeJS.ProcessEnv }): EditHookOutcome {
  const host = getHost(opts.host);
  const env = opts.env ?? process.env;
  if (!host.edit) return { stdout: '', why: `${host.displayName} has no agent-visible channel after an edit`, notes: [] };
  const silent = (why: string): EditHookOutcome => ({ stdout: host.edit ? host.edit.silent() : '', why, notes: [] });
  if (env.ISITDONE === '1') return silent('nested inside an isitdone check');
  const raw = parsePayload(opts.stdin);
  if (!raw) return silent('stdin was not a JSON object');
  const input = host.edit.parse(raw);
  if (input.files.length === 0) return silent('no file path in the payload');
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : (opts.cwd ?? process.cwd());
  const top = gitTopLevel(cwd);
  if (!top) return silent('not inside a git repository');
  // Remember who edited what: with two sessions in one working tree, the Stop hook must not hold one session to the
  // other's unfinished files. host.parse reads the session id from the same payload fields the Stop event uses.
  recordEdits(findRoot(cwd), host.name, host.parse(raw).sessionId, input.files.map((file) => toRepoPath(top, file, cwd)).filter(insideRepo));
  try {
    if (loadConfig(findRoot(cwd)).config.integrity === 'off') return silent('integrity scan is off in config');
  } catch {
    // a broken config is reported by the Stop hook; the edit hook stays quiet
  }
  // One working-tree diff per hook run, taken only once an edited file turns out to be worth scanning.
  let diff: DiffResult | null = null;
  const diffOnce = (): DiffResult => {
    if (!diff) diff = collectDiff(top);
    return diff;
  };
  const notes: string[] = [];
  for (const file of input.files.slice(0, 8)) {
    try {
      const r = checkEditedFile(cwd, file, 'HEAD', diffOnce);
      if (r?.note) notes.push(r.note);
    } catch {
      // a scan problem must never disturb the agent's tool call
    }
  }
  if (notes.length === 0) return silent(`nothing weakened in ${input.files.length} file(s)`);
  return { stdout: host.edit.warn(notes.join('\n\n')), why: `${notes.length} note(s)`, notes };
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
      try {
        process.stdin.pause();
        process.stdin.destroy();
      } catch {
        // ignore
      }
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
