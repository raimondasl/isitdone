/**
 * Several agent sessions can share one working tree. The checks see the whole tree, so without care one session is
 * blocked for (and told to "fix") files another session is still editing. This module keeps the evidence needed to
 * tell them apart: the post-edit hook records which session touched which file, and the Stop hook asks whose files a
 * failure names. It also serialises check runs, so two sessions stopping together do not run the suite on top of each
 * other. Everything here fails open: a missing or unreadable record means "no evidence", never a block.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tryReadJsonFile } from './fsutil.js';
import { RECEIPT_DIR } from './git.js';
import { ensureStateDir } from './receipt.js';

export const SESSIONS_DIR = 'sessions';
const EDITS_EXT = '.edits';
/** Another session counts as working here when its hooks fired this recently. */
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
/** Edit records older than this are ignored (the state files are pruned at the same age). */
const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PATHS_PER_EVENT = 50;

/** File-name stem shared by a session's state file (`.json`) and its edit records (`.edits`). */
export function sessionKey(host: string, sessionId: string | null): string {
  return `${host}-${createHash('sha1').update(sessionId ?? 'anon').digest('hex').slice(0, 16)}`;
}

function sessionsDir(root: string): string {
  return join(root, RECEIPT_DIR, SESSIONS_DIR);
}

/** Remember that this session edited these repo-relative paths. Never throws. */
export function recordEdits(root: string, host: string, sessionId: string | null, paths: string[], now = Date.now()): void {
  // Without a session id every session would share one record, which proves nothing about who edited what.
  if (sessionId === null || paths.length === 0) return;
  try {
    ensureStateDir(root);
    mkdirSync(sessionsDir(root), { recursive: true });
    const lines = paths.slice(0, MAX_PATHS_PER_EVENT).map((p) => JSON.stringify({ t: now, p }) + '\n');
    appendFileSync(join(sessionsDir(root), sessionKey(host, sessionId) + EDITS_EXT), lines.join(''));
  } catch {
    // no record, no attribution
  }
}

export interface SessionEdits {
  key: string;
  /** Latest sign of life: newest edit record or the state file's updatedAt. */
  lastActive: number;
  /** Repo-relative path -> time of the latest edit by this session. */
  files: Map<string, number>;
}

export function readSessions(root: string, now = Date.now()): SessionEdits[] {
  const dir = sessionsDir(root);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = new Map<string, SessionEdits>();
  const get = (key: string): SessionEdits => {
    let s = out.get(key);
    if (!s) {
      s = { key, lastActive: 0, files: new Map() };
      out.set(key, s);
    }
    return s;
  };
  for (const e of entries) {
    if (e.endsWith(EDITS_EXT)) {
      let text: string;
      try {
        text = readFileSync(join(dir, e), 'utf8');
      } catch {
        continue;
      }
      const s = get(e.slice(0, -EDITS_EXT.length));
      for (const line of text.split('\n')) {
        if (line === '') continue;
        try {
          const rec = JSON.parse(line) as { t?: unknown; p?: unknown };
          if (typeof rec.t !== 'number' || typeof rec.p !== 'string' || now - rec.t > RECORD_MAX_AGE_MS) continue;
          if ((s.files.get(rec.p) ?? 0) < rec.t) s.files.set(rec.p, rec.t);
          if (rec.t > s.lastActive) s.lastActive = rec.t;
        } catch {
          // a torn line from a concurrent append
        }
      }
    } else if (e.endsWith('.json')) {
      const st = tryReadJsonFile<{ updatedAt?: string }>(join(dir, e));
      const t = st?.updatedAt ? Date.parse(st.updatedAt) : NaN;
      if (!Number.isNaN(t)) {
        const s = get(e.slice(0, -'.json'.length));
        if (t > s.lastActive) s.lastActive = t;
      }
    }
  }
  return [...out.values()];
}

export interface ForeignFile {
  path: string;
  /** When the other session last edited it. */
  editedAt: number;
}

export interface Attribution {
  /** Every path this session is recorded as having edited. */
  mine: Set<string>;
  /** Uncommitted files an active other session edited and this session did not. */
  foreign: ForeignFile[];
  /** Uncommitted files both this session and an active other session edited. */
  shared: ForeignFile[];
  /** When the most recently active other session with uncommitted edits last did anything. */
  otherLastActive: number | null;
}

/**
 * Who edited the uncommitted files? Only positive evidence counts: a dirty file nobody recorded (the user's own edit,
 * a formatter, a shell command) is nobody's, and a session that went quiet ACTIVE_WINDOW_MS ago is no longer "working
 * here": its leftovers are simply the state of the tree.
 */
export function attribute(root: string, host: string, sessionId: string | null, dirty: Set<string>, now = Date.now()): Attribution {
  const me = sessionKey(host, sessionId);
  const mine = new Set<string>();
  const others = new Map<string, number>();
  let otherLastActive: number | null = null;
  for (const s of readSessions(root, now)) {
    if (s.key === me && sessionId !== null) {
      for (const p of s.files.keys()) mine.add(p);
      continue;
    }
    if (now - s.lastActive > ACTIVE_WINDOW_MS) continue;
    let counted = false;
    for (const [p, t] of s.files) {
      if (!dirty.has(p)) continue;
      counted = true;
      if ((others.get(p) ?? 0) < t) others.set(p, t);
    }
    if (counted && (otherLastActive === null || s.lastActive > otherLastActive)) otherLastActive = s.lastActive;
  }
  const foreign: ForeignFile[] = [];
  const shared: ForeignFile[] = [];
  for (const [path, editedAt] of others) (mine.has(path) ? shared : foreign).push({ path, editedAt });
  const byPath = (a: ForeignFile, b: ForeignFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { mine, foreign: foreign.sort(byPath), shared: shared.sort(byPath), otherLastActive };
}

/**
 * For the CLI, which does not know which session is asking: when two or more live sessions have uncommitted edits
 * here, say who edited what, so an agent reading a NOT DONE report fixes only its own files. Null otherwise.
 */
export function liveSessionsNote(root: string, dirty: Set<string>, now = Date.now()): string | null {
  const live = readSessions(root, now)
    .filter((s) => now - s.lastActive <= ACTIVE_WINDOW_MS)
    .map((s) => ({ ...s, dirty: [...s.files.keys()].filter((p) => dirty.has(p)).sort() }))
    .filter((s) => s.dirty.length > 0)
    .sort((a, b) => b.lastActive - a.lastActive);
  if (live.length < 2) return null;
  const lines = [`  note: ${live.length} agent sessions have uncommitted edits in this directory. If you are one of them, fix only the files you edited and leave the others alone:`];
  for (const s of live.slice(0, 5)) {
    const shown = s.dirty.slice(0, 8).join(', ') + (s.dirty.length > 8 ? `, ... ${s.dirty.length - 8} more` : '');
    lines.push(`    ${s.key.slice(0, s.key.lastIndexOf('-') + 7)} (active ${formatAgo(now - s.lastActive)}): ${shown}`);
  }
  return lines.join('\n');
}

/** Base names too common to identify a file when a tool prints only `name:line`. */
const GENERIC_BASENAME = /^(?:index|main|mod|lib|utils?|helpers?|types?|common|base|core|config|constants|setup|conftest|__init__|test|tests|app)\.[A-Za-z0-9]+$/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does this check output name the file? `output` must already have backslashes turned into slashes. Matches the
 * repo-relative path, the path relative to the project root (checks run there, which in a monorepo is below the git
 * top-level), or, for distinctive names, a bare `Name.ext:12` / `(Name.ext:12)` as Go and the JVM print.
 */
export function mentions(output: string, path: string, rootPrefix = ''): boolean {
  const name = basename(path);
  // Every form below contains the base name: one plain search spares the regexes on a megabyte of output.
  if (!output.includes(name)) return false;
  const bounded =(p: string) => new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRe(p)}(?![A-Za-z0-9_-])`, 'm').test(output);
  if (bounded(path)) return true;
  if (rootPrefix && path.startsWith(rootPrefix) && path.length > rootPrefix.length && bounded(path.slice(rootPrefix.length))) return true;
  if (name === path || GENERIC_BASENAME.test(name) || !/\.[A-Za-z0-9]+$/.test(name)) return false;
  return new RegExp(`(?:^|[\\s(\\[])${escapeRe(name)}[:(]\\d`, 'm').test(output);
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

const LOCK_FILE = 'run.lock';
/** Longest a Stop hook waits for another session's check run before running anyway. */
export const LOCK_WAIT_MS = 180_000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_POLL_MS = 400;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RunLock {
  /** False when the wait ran out (or the lock could not be written) and the run goes ahead unserialised. */
  held: boolean;
  waitedMs: number;
  release(): void;
}

/**
 * One check run per project at a time across sessions: two test runs in one directory fight over caches, build output
 * and ports and fail for reasons neither change caused. A holder that died or is implausibly old is ignored. While
 * waiting the caller holds nothing, so there is no deadlock; when the wait runs out the run simply proceeds as before.
 */
export async function acquireRunLock(root: string, waitMs = LOCK_WAIT_MS): Promise<RunLock> {
  const started = Date.now();
  const none = (): RunLock => ({ held: false, waitedMs: Date.now() - started, release: () => {} });
  let file: string;
  try {
    file = join(ensureStateDir(root), LOCK_FILE);
  } catch {
    return none();
  }
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), { flag: 'wx' });
      return {
        held: true,
        waitedMs: Date.now() - started,
        release: () => {
          try {
            if (tryReadJsonFile<{ token?: string }>(file)?.token === token) rmSync(file, { force: true });
          } catch {
            // a leftover lock is cleared by the next run (dead pid)
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return none();
    }
    const holder = tryReadJsonFile<{ pid?: number; startedAt?: number }>(file);
    let stale = holder !== null && (typeof holder.pid !== 'number' || !alive(holder.pid) || typeof holder.startedAt !== 'number' || Date.now() - holder.startedAt > LOCK_STALE_MS);
    if (holder === null) {
      // Unreadable: mid-write (fresh) or left empty by a process that died between create and write (old).
      try {
        stale = Date.now() - statSync(file).mtimeMs > 10_000;
      } catch {
        continue; // it vanished: try to take it
      }
    }
    if (stale) {
      try {
        rmSync(file, { force: true });
      } catch {
        return none();
      }
      continue;
    }
    if (Date.now() - started >= waitMs) return none();
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}
