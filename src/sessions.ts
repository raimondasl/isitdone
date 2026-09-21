/**
 * Several agent sessions can share one working tree. The checks see the whole tree, so without care one session is
 * blocked for (and told to "fix") files another session is still editing. This module keeps the evidence needed to
 * tell them apart: the post-edit hook records which session touched which file, and the Stop hook asks whose files a
 * failure names. It also serialises check runs, so two sessions stopping together do not run the suite on top of each
 * other.
 *
 * Two rules bound everything here. A session on its own must be gated exactly as if this module did not exist: a
 * conversation that ended (/clear, a restart) is not "another session", so concurrency needs proof, namely hook
 * activity of the other session AFTER this session's first. And nothing here may brick the agent: a missing or
 * unreadable record means "no evidence".
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tryReadJsonFile, writeFileAtomic } from './fsutil.js';
import { RECEIPT_DIR } from './git.js';
import { ensureStateDir } from './receipt.js';

export const SESSIONS_DIR = 'sessions';
const EDITS_EXT = '.edits';
/** How long after its last hook activity another session's uncommitted files still count as its work in progress. */
export const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Other sessions' edit records older than this are ignored (their files are pruned at the same age). */
const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PATHS_PER_EVENT = 50;
const COMPACT_ABOVE_BYTES = 64 * 1024;

/** File-name stem shared by a session's state file (`.json`) and its edit records (`.edits`). */
export function sessionKey(host: string, sessionId: string | null): string {
  return `${host}-${createHash('sha1').update(sessionId ?? 'anon').digest('hex').slice(0, 16)}`;
}

function sessionsDir(base: string): string {
  return join(base, RECEIPT_DIR, SESSIONS_DIR);
}

/**
 * Remember that this session edited these paths (relative to the git top-level). Records live under the top-level, not
 * the project root: the paths are top-relative, and the session's directory can drift between sub-projects while the
 * Stop hook reads from one place. Never throws.
 */
export function recordEdits(top: string, host: string, sessionId: string | null, paths: string[], now = Date.now()): void {
  // Without a session id every session would share one record, which proves nothing about who edited what.
  if (sessionId === null || paths.length === 0) return;
  try {
    ensureStateDir(top);
    mkdirSync(sessionsDir(top), { recursive: true });
    const lines = paths.slice(0, MAX_PATHS_PER_EVENT).map((p) => JSON.stringify({ t: now, p }) + '\n');
    appendFileSync(join(sessionsDir(top), sessionKey(host, sessionId) + EDITS_EXT), lines.join(''));
  } catch {
    // no record, no attribution
  }
}

export interface SessionEdits {
  key: string;
  /** Earliest and latest sign of life: edit records and the state file's firstSeen / updatedAt. */
  firstSeen: number;
  lastActive: number;
  /** Repo-relative path -> time of the latest edit by this session. */
  files: Map<string, number>;
}

/** Sessions seen in these directories' `.isitdone/sessions` (the git top-level holds the edits, the project root the state). */
export function readSessions(bases: string[]): SessionEdits[] {
  const out = new Map<string, SessionEdits>();
  const get = (key: string): SessionEdits => {
    let s = out.get(key);
    if (!s) {
      s = { key, firstSeen: Infinity, lastActive: 0, files: new Map() };
      out.set(key, s);
    }
    return s;
  };
  const seen = (s: SessionEdits, t: number) => {
    if (t < s.firstSeen) s.firstSeen = t;
    if (t > s.lastActive) s.lastActive = t;
  };
  for (const base of new Set(bases)) {
    const dir = sessionsDir(base);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
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
            if (typeof rec.t !== 'number' || typeof rec.p !== 'string') continue;
            if ((s.files.get(rec.p) ?? 0) < rec.t) s.files.set(rec.p, rec.t);
            seen(s, rec.t);
          } catch {
            // a torn line from a concurrent append
          }
        }
      } else if (e.endsWith('.json')) {
        const st = tryReadJsonFile<{ updatedAt?: string; firstSeen?: string }>(join(dir, e));
        const s = get(e.slice(0, -'.json'.length));
        for (const iso of [st?.firstSeen, st?.updatedAt]) {
          const t = iso ? Date.parse(iso) : NaN;
          if (!Number.isNaN(t)) seen(s, t);
        }
      }
    }
  }
  return [...out.values()];
}

/** Keep one record per path once a long session's file has grown; a record lost to a concurrent append is harmless. */
export function compactEdits(top: string, host: string, sessionId: string | null): void {
  if (sessionId === null) return;
  const file = join(sessionsDir(top), sessionKey(host, sessionId) + EDITS_EXT);
  try {
    if (statSync(file).size < COMPACT_ABOVE_BYTES) return;
    const me = readSessions([top]).find((s) => s.key === sessionKey(host, sessionId));
    if (!me) return;
    const lines = [...me.files].map(([p, t]) => JSON.stringify({ t, p }) + '\n');
    // The first record carries the session's start: concurrency is judged against it.
    lines.unshift(JSON.stringify({ t: me.firstSeen, p: [...me.files.keys()][0] ?? '' }) + '\n');
    writeFileAtomic(file, lines.join(''));
  } catch {
    // leave it as it is
  }
}

export interface ForeignFile {
  path: string;
  /** When the other session last edited it. */
  editedAt: number;
}

export interface Attribution {
  /** Every path this session is recorded as having edited. */
  mine: Set<string>;
  /** Uncommitted files a concurrent session edited and this session did not. */
  foreign: ForeignFile[];
  /** Uncommitted files both this session and a concurrent session edited. */
  shared: ForeignFile[];
  /** When the most recently active concurrent session with uncommitted edits last did anything. */
  otherLastActive: number;
}

/**
 * Is another session working in this tree, and which uncommitted files are its? Null unless there is proof:
 *  - the other session's hooks fired AFTER this session's first recorded activity (so it is not a predecessor that
 *    ended before this one began: /clear, a restart, yesterday's conversation), and within ACTIVE_WINDOW_MS;
 *  - it recorded edits to files that are still uncommitted.
 * A dirty file nobody recorded (the user's own edit, a formatter, a shell command) is nobody's. `dirty` is only asked
 * for once a concurrent session is found, so the usual single-session stop costs one directory listing.
 */
export function attribute(bases: string[], host: string, sessionId: string | null, dirty: () => Set<string>, now = Date.now()): Attribution | null {
  if (sessionId === null) return null;
  const sessions = readSessions(bases);
  const meKey = sessionKey(host, sessionId);
  const me = sessions.find((s) => s.key === meKey);
  const myStart = me && Number.isFinite(me.firstSeen) ? me.firstSeen : now;
  const concurrent = sessions.filter((s) => s.key !== meKey && s.files.size > 0 && s.lastActive > myStart && now - s.lastActive <= ACTIVE_WINDOW_MS);
  if (concurrent.length === 0) return null;
  const dirtyNow = dirty();
  const mine = new Set(me ? me.files.keys() : []);
  const others = new Map<string, number>();
  let otherLastActive = 0;
  for (const s of concurrent) {
    let counted = false;
    for (const [p, t] of s.files) {
      if (!dirtyNow.has(p) || now - t > RECORD_MAX_AGE_MS) continue;
      counted = true;
      if ((others.get(p) ?? 0) < t) others.set(p, t);
    }
    if (counted && s.lastActive > otherLastActive) otherLastActive = s.lastActive;
  }
  if (others.size === 0) return null;
  const foreign: ForeignFile[] = [];
  const shared: ForeignFile[] = [];
  for (const [path, editedAt] of others) (mine.has(path) ? shared : foreign).push({ path, editedAt });
  const byPath = (a: ForeignFile, b: ForeignFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { mine, foreign: foreign.sort(byPath), shared: shared.sort(byPath), otherLastActive };
}

/**
 * For the CLI, which does not know which session is asking: when sessions whose activity overlapped in time have
 * uncommitted edits here, say who edited what, so an agent reading a NOT DONE report fixes only its own files.
 */
export function liveSessionsNote(bases: string[], dirty: () => Set<string>, now = Date.now()): string | null {
  const recent = readSessions(bases).filter((s) => s.files.size > 0 && now - s.lastActive <= ACTIVE_WINDOW_MS);
  const overlapping = recent.filter((s) => recent.some((t) => t !== s && s.firstSeen < t.lastActive && t.firstSeen < s.lastActive));
  if (overlapping.length < 2) return null;
  const dirtyNow = dirty();
  const live = overlapping
    .map((s) => ({ ...s, dirty: [...s.files.keys()].filter((p) => dirtyNow.has(p)).sort() }))
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
/** Characters that can belong to a path token in tool output (spaces end a token: a path with spaces is seen from its last space on). */
const PATH_CHAR = /[^\s"'`<>|*?,;=]/;

export interface MentionContext {
  /** Check output: ANSI stripped, backslashes turned into slashes, lower-cased when `fold`. */
  text: string;
  /** Absolute git top-level with forward slashes, lower-cased when `fold`. */
  top: string;
  /** Base name -> every repository path (tracked and uncommitted) with that base name, lower-cased when `fold`. */
  byBase: Map<string, string[]>;
  /** Case-insensitive file system: everything above is lower-cased, and so is the path asked about. */
  fold: boolean;
}

export function mentionContext(output: string, top: string, repoPaths: Iterable<string>, fold = process.platform === 'win32' || process.platform === 'darwin'): MentionContext {
  const norm = (s: string) => (fold ? s.toLowerCase() : s);
  const byBase = new Map<string, string[]>();
  for (const p of repoPaths) {
    const q = norm(p);
    const name = q.slice(q.lastIndexOf('/') + 1);
    const list = byBase.get(name);
    if (list) list.push(q);
    else byBase.set(name, [q]);
  }
  // eslint-disable-next-line no-control-regex
  const text = norm(output.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\\/g, '/'));
  return { text, top: norm(top.replace(/\\/g, '/').replace(/\/$/, '')), byBase, fold };
}

/**
 * Does the check output name this file? Every occurrence of the base name is widened to the whole path token around
 * it, and the token must resolve to this file: the repo-relative path, an absolute path under the top-level, or a
 * shorter trailing part (what a check run from a sub-directory or a workspace prints) that no other repository file
 * ends with. A bare `Name.ext:12` (Go, the JVM) counts only for a distinctive base name that is unique in the
 * repository. `lib/src/a.ts` therefore does not name `src/a.ts`, and `a.ts.map` names nothing.
 */
export function mentions(ctx: MentionContext, file: string): boolean {
  const path = ctx.fold ? file.toLowerCase() : file;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === '') return false;
  const text = ctx.text;
  const sameBase = ctx.byBase.get(name) ?? [path];
  const resolves = (token: string, end: number): boolean => {
    let t = token;
    const k = t.indexOf(`${ctx.top}/`);
    if (k >= 0) t = t.slice(k + ctx.top.length + 1);
    else {
      t = t.replace(/^[a-z][a-z0-9+.-]*:\/\/+(?![a-z]:\/)/i, '').replace(/^[a-z][a-z0-9+.-]*:\/\/+/i, '');
      while (t.startsWith('./')) t = t.slice(2);
      if (t.startsWith('/') || /^[a-z]:\//i.test(t)) return false; // an absolute path somewhere else
    }
    if (t === path && t.includes('/')) return true;
    if (t !== path && !path.endsWith(`/${t}`)) return false;
    const unique = sameBase.filter((p) => p === t || p.endsWith(`/${t}`)).length <= 1;
    if (t.includes('/')) return unique;
    // A bare base name: a root-level file printed as itself, or a tool that prints names without directories.
    if (!unique) return false;
    if (t === path) return true;
    return !GENERIC_BASENAME.test(name) && /^[:(]\d/.test(text.slice(end, end + 2));
  };
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    const end = i + name.length;
    const next = text[end];
    if (next !== undefined && /[A-Za-z0-9_-]/.test(next)) continue;
    if (next === '.' && /[A-Za-z0-9]/.test(text[end + 1] ?? '')) continue; // a.ts.map, a.test.ts.snap
    let start = i;
    while (start > 0 && PATH_CHAR.test(text[start - 1] as string)) start--;
    const token = text.slice(start, end);
    if (token.length > name.length && /[A-Za-z0-9_.-]/.test(token[token.length - name.length - 1] as string)) continue; // "myfoo.ts"
    if (resolves(token, end)) return true;
    // Glued text: "at fn (src/a.js:5:11)", "finds(FooTest.java:17)", "[src/a.js]", "error:src/a.js". A path that really
    // contains brackets (app/(group)/page.tsx) resolved as a whole above.
    const open = Math.max(token.lastIndexOf('('), token.lastIndexOf('['), token.lastIndexOf('{'));
    const inner = (open >= 0 ? token.slice(open + 1) : token).replace(/^[a-z]+:(?!\/)/i, '');
    if (inner !== token && inner.endsWith(name) && resolves(inner, end)) return true;
  }
  return false;
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

const LOCK_FILE = 'run.lock';
/** Longest a Stop hook waits for another check run before running anyway. */
export const LOCK_WAIT_MS = 180_000;
/** The holder refreshes the lock's mtime this often; a lock not refreshed for LOCK_STALE_MS belongs to a dead process. */
const LOCK_BEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 400;

export interface RunLock {
  /** False when the wait ran out (or the lock could not be written) and the run goes ahead unserialised. */
  held: boolean;
  waitedMs: number;
  release(): void;
}

/**
 * One check run per project at a time across sessions: two test runs in one directory fight over caches, build output
 * and ports and fail for reasons neither change caused. Liveness is a heartbeat (the holder touches the file every few
 * seconds), not a pid: pids are recycled within seconds on Windows and mean nothing across containers. While waiting
 * the caller holds nothing, so there is no deadlock; when the wait runs out the run simply proceeds as before.
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
  const tokenOf = (): string | null => tryReadJsonFile<{ token?: string }>(file)?.token ?? null;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), { flag: 'wx' });
      const beat = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(file, now, now);
        } catch {
          // the next waiter may take over; the run itself is unaffected
        }
      }, LOCK_BEAT_MS);
      beat.unref();
      return {
        held: true,
        waitedMs: Date.now() - started,
        release: () => {
          clearInterval(beat);
          try {
            if (tokenOf() === token) rmSync(file, { force: true });
          } catch {
            // a leftover lock goes stale by itself
          }
        },
      };
    } catch (err) {
      // EEXIST: held. EPERM/EBUSY: Windows, the file is being deleted or is momentarily open. Anything else: no lock.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') return none();
    }
    try {
      const st = statSync(file);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Take over only the lock that was judged stale: if a new holder appeared in between, its token or mtime differs.
        const judged = tokenOf();
        const again = statSync(file);
        if (again.mtimeMs === st.mtimeMs && tokenOf() === judged) rmSync(file, { force: true });
      }
    } catch {
      // it vanished or cannot be read: the next round tries to take it
    }
    if (Date.now() - started >= waitMs) return none();
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}
