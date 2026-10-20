/**
 * `isitdone pause`: the user's switch for turning the Stop hook off for a while, in one repository (every worktree of it)
 * or for every repository of this user, that turns itself back on. The hook reads the pause at every stop and while its
 * checks run, so a pause reaches agent sessions that are already running, and stops a suite that is already going.
 * Only the automatic gate pauses: `npx isitdone`, the MCP tools and CI still run the checks.
 *
 * Pauses live under ~/.isitdone/pauses/, outside every project, so an agent cannot switch its own gate off with an
 * ordinary file edit in its workspace; `pause` itself refuses to run in a shell that looks like an agent's. Neither is
 * proof against a determined agent, so a paused stop is never quiet where it matters: every paused stop whose final
 * message claims completion, and every pause that cuts a block short, tells the user (on hosts that can show a message).
 */
import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tryReadJsonFile, writeFileAtomic } from './fsutil.js';
import { gitCommonDir, RECEIPT_DIR } from './git.js';

export const PAUSES_DIR = 'pauses';
export const GLOBAL_PAUSE = 'global.json';
export const DEFAULT_PAUSE_MS = 60 * 60 * 1000;
/** Longer than this is not a pause; a file claiming more is ignored, so a forgotten or forged one cannot last for ever. */
export const MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

export type PauseScope = 'repo' | 'global';

export interface PauseRecord {
  until: string;
  createdAt: string;
  scope: PauseScope;
  /** Where `pause` was run, for messages (repository pauses only). */
  repo?: string;
  /** The isitdone version that wrote it. */
  version: string;
}

export interface ActivePause extends PauseRecord {
  file: string;
  untilMs: number;
}

/** ~/.isitdone/pauses, or null when the home directory cannot be resolved (then nothing is paused: the gate runs). */
export function pausesDir(): string | null {
  try {
    const home = homedir();
    return home ? join(home, RECEIPT_DIR, PAUSES_DIR) : null;
  } catch {
    return null;
  }
}

/** One key per repository: worktrees share the git common dir. Case-folded where the file system ignores case. */
export function repoPauseKey(cwd: string): string | null {
  const common = gitCommonDir(cwd);
  if (!common) return null;
  const norm = process.platform === 'win32' || process.platform === 'darwin' ? common.toLowerCase() : common;
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

export interface PauseFiles {
  global: string | null;
  repo: string | null;
}

/**
 * A lookup of the files that can pause the hook in `cwd`, for calling again and again (the hook polls it while checks
 * run). Working out the repository's key costs a git call: it is made only once some repository pause exists at all,
 * and then only once per lookup.
 */
export function pauseLookup(cwd: string | null): () => PauseFiles {
  let key: string | null | undefined;
  return () => {
    const dir = pausesDir();
    if (!dir) return { global: null, repo: null };
    let anyRepo = false;
    try {
      anyRepo = readdirSync(dir).some((e) => e.startsWith('repo-'));
    } catch {
      // no pauses directory: nothing is paused
    }
    if (anyRepo && key === undefined) key = cwd ? repoPauseKey(cwd) : null;
    return { global: join(dir, GLOBAL_PAUSE), repo: anyRepo && key ? join(dir, `repo-${key}.json`) : null };
  };
}

export function pauseFiles(cwd: string | null): PauseFiles {
  return pauseLookup(cwd)();
}

/**
 * Removes repository pauses that have run out, so the hook stops paying a git call per stop for them. Done by the CLI
 * (pause, resume), never by the hook: a hook deleting a file could race a `pause` writing a new one at the same path.
 */
function pruneExpired(dir: string, now: number): void {
  try {
    for (const e of readdirSync(dir)) {
      if (e.startsWith('repo-') && e.endsWith('.json') && readPause(join(dir, e), 'repo', now) === null) rmSync(join(dir, e), { force: true });
    }
  } catch {
    // best effort
  }
}

function readPause(file: string | null, scope: PauseScope, now: number): ActivePause | null {
  if (!file) return null;
  const p = tryReadJsonFile<Partial<PauseRecord>>(file);
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.until !== 'string') return null;
  const untilMs = Date.parse(p.until);
  if (!Number.isFinite(untilMs) || untilMs <= now || untilMs - now > MAX_PAUSE_MS) return null;
  return {
    until: new Date(untilMs).toISOString(),
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
    scope,
    repo: typeof p.repo === 'string' ? p.repo : undefined,
    version: typeof p.version === 'string' ? p.version : '',
    file,
    untilMs,
  };
}

/**
 * The pause in force, or null. When both a repository pause and the user-wide one are active, the one that ends last wins.
 * Expired, malformed and over-long files are ignored: when in doubt, the gate runs. Never throws.
 */
export function activePause(files: PauseFiles, now = Date.now()): ActivePause | null {
  try {
    const found = [readPause(files.repo, 'repo', now), readPause(files.global, 'global', now)].filter((p): p is ActivePause => p !== null);
    return found.sort((a, b) => b.untilMs - a.untilMs)[0] ?? null;
  } catch {
    return null;
  }
}

/** Writes a pause; for a repository pause, `cwd` must be inside the repository. */
export function writePause(scope: PauseScope, cwd: string | null, untilMs: number, version: string, now = Date.now(), repo?: string): ActivePause {
  const dir = pausesDir();
  if (!dir) throw new Error('the home directory cannot be resolved, so there is nowhere to keep a pause');
  let file = join(dir, GLOBAL_PAUSE);
  if (scope === 'repo') {
    const key = cwd ? repoPauseKey(cwd) : null;
    if (!key) throw new Error('not inside a git repository');
    file = join(dir, `repo-${key}.json`);
  }
  const rec: PauseRecord = { until: new Date(untilMs).toISOString(), createdAt: new Date(now).toISOString(), scope, ...(scope === 'repo' && repo ? { repo } : {}), version };
  writeFileAtomic(file, JSON.stringify(rec, null, 2) + '\n');
  pruneExpired(dir, now);
  return { ...rec, file, untilMs };
}

/** Removes one pause file; returns the pause it held if that was still in force. */
export function clearPause(file: string | null, scope: PauseScope, now = Date.now()): ActivePause | null {
  const dir = pausesDir();
  if (dir) pruneExpired(dir, now);
  if (!file) return null;
  const p = readPause(file, scope, now);
  rmSync(file, { force: true });
  return p;
}

/**
 * Variables that agent hosts set in the shells they run commands in. Any of them being present, even empty, marks the shell
 * as an agent's. Best effort: a host that sets none of these cannot be told apart, and `env -u` defeats the check.
 */
export const AGENT_SHELL_MARKERS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'AI_AGENT',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'QWEN_CODE',
];

export function isAgentShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_SHELL_MARKERS.some((v) => env[v] !== undefined);
}

/** `30m`, `2h`, `3d`, `1w`: how long a pause lasts. Minutes here, unlike `history --since`, where `m` is a month. */
export function parseDuration(v: string): number | null {
  const m = /^(\d+)\s*(m|min|h|d|w)$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  const ms = unit === 'm' || unit === 'min' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000;
  return n > 0 ? n * ms : null;
}

/**
 * An ISO date or time. A bare date means the end of that day, and a time without a zone is local time; `Z` or an offset
 * says otherwise. Impossible dates (2026-02-30) are refused rather than rolled over into the next month.
 */
export function parseUntil(v: string): number | null {
  const t = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(.+))?$/.exec(t);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  const ms = m[4] === undefined ? new Date(y, mo - 1, d, 23, 59, 59, 999).getTime() : Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[5]}`);
  return Number.isFinite(ms) ? ms : null;
}

const two = (n: number) => String(n).padStart(2, '0');

/** "2026-11-02 11:00 UTC (07:00 local)", with the local date when it differs. */
export function formatPauseTime(ms: number): string {
  const d = new Date(ms);
  const utcDate = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const localDate = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const utc = `${utcDate} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
  if (d.getTimezoneOffset() === 0) return utc;
  return `${utc} (${localDate === utcDate ? '' : localDate + ' '}${two(d.getHours())}:${two(d.getMinutes())} local)`;
}

/** "45 min", "1 h 30 min", "2 d 4 h": rounded down, never up. */
export function formatSpan(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const days = Math.floor(h / 24);
  return h % 24 ? `${days} d ${h % 24} h` : `${days} d`;
}

export function describePause(p: ActivePause, now = Date.now()): string {
  return `${p.scope === 'global' ? 'for every repository of this user' : 'in this repository'} until ${formatPauseTime(p.untilMs)} (${formatSpan(p.untilMs - now)} from now)`;
}
