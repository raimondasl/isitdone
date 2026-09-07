/**
 * Cursor transcripts for `isitdone history`.
 *
 * Primary source: the bubble store in <Cursor user dir>/globalStorage/state.vscdb (SQLite in WAL mode), read in place
 * through node:sqlite when this Node has it without flags (22.13+, 24+): `composerData:<composerId>` rows describe a
 * conversation and list its bubbles in order, `bubbleId:<composerId>:<bubbleId>` rows hold each message (type 1 user,
 * type 2 assistant) with the tool call in `toolFormerData` (edit_file_v2 = tool 38, run_terminal_command_v2 = tool 15
 * whose result JSON carries exitCode), and bubble `createdAt` timestamps. Projects come from the composer.composerHeaders
 * index in ItemTable (Cursor 3.0+) or from workspaceStorage/<id>/{state.vscdb composer.composerData, workspace.json}.
 * Fallback (Node 20, or the DB missing/unreadable): ~/.cursor/projects/<slug>/agent-transcripts/**.jsonl, which has the
 * prompts, assistant text and tool_use blocks but no tool results, exit codes or timestamps: test runs there are
 * recorded with an unknown exit status and the session is flagged lossy.
 * // verified: toolpath docs/agents/formats/cursor.md, cursaves how-cursor-stores-chats.md, entireio real_session_tool_use
 * // fixture, cursor-history storage.ts, opik spanBuilder.ts (2026-09-07); no Cursor install was available locally.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSessionFile } from './gemini.js';
import { TurnTracker, ts, type ClaimRecord, type TurnStats } from './turns.js';

type Rec = Record<string, unknown>;

/** The slice of node:sqlite this module uses (typed locally: the module is loaded at runtime, never imported). */
export interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): Rec[]; get(...params: unknown[]): Rec | undefined };
  close(): void;
}
export interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDb;
}

let sqliteCache: SqliteModule | null | undefined;

/**
 * node:sqlite when this Node ships it unflagged, else null. Never imported at module top level: Node 20 has no such
 * builtin and 22.5-22.12 need --experimental-sqlite. Its ExperimentalWarning is swallowed while loading.
 */
export function loadSqlite(): SqliteModule | null {
  if (sqliteCache !== undefined) return sqliteCache;
  const warn = process.emitWarning;
  const quiet = (...args: unknown[]) => {
    if (!/sqlite/i.test(String(args[0]))) (warn as (...a: unknown[]) => void).apply(process, args);
  };
  process.emitWarning = quiet as typeof process.emitWarning;
  let mod: unknown = null;
  try {
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof get === 'function') mod = get.call(process, 'node:sqlite');
    if (!mod) mod = createRequire(import.meta.url)('node:sqlite');
  } catch {
    mod = null;
  } finally {
    process.emitWarning = warn;
  }
  const m = mod as Partial<SqliteModule> | null;
  sqliteCache = m && typeof m.DatabaseSync === 'function' ? (m as SqliteModule) : null;
  return sqliteCache;
}

export function defaultCursorDir(): string {
  return join(homedir(), '.cursor');
}

/** Cursor's Electron user-data dir: %APPDATA%\Cursor\User, ~/Library/Application Support/Cursor/User, ~/.config/Cursor/User. */
export function defaultCursorUserDir(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA && process.env.APPDATA !== '' ? process.env.APPDATA : join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  return join(process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== '' ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config'), 'Cursor', 'User');
}

function obj(v: unknown): Rec | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A cursorDiskKV / ItemTable value (BLOB or TEXT) parsed as JSON, or null. */
function valueJson(v: unknown): Rec | null {
  try {
    const text = typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8') : '';
    return text ? obj(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

function parseJson(v: unknown): Rec | null {
  if (typeof v !== 'string') return obj(v);
  try {
    return obj(JSON.parse(v));
  } catch {
    return null;
  }
}

/** A VS Code folder URI as a path: file:///C:/x -> C:\x, other schemes (vscode-remote://...) decoded as-is. */
export function uriToPath(uri: string): string {
  try {
    if (uri.startsWith('file:')) return fileURLToPath(uri);
  } catch {
    // fall through
  }
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/** workspaceStorage/<id> -> folder path from its workspace.json ({"folder": "file:///..."} or {"workspace": "...code-workspace"}). */
function workspaceFolders(userDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const ws = join(userDir, 'workspaceStorage');
  if (!isDir(ws)) return map;
  for (const id of readdirSync(ws)) {
    try {
      const j = obj(JSON.parse(readFileSync(join(ws, id, 'workspace.json'), 'utf8')));
      const uri = typeof j?.folder === 'string' ? j.folder : typeof j?.workspace === 'string' ? j.workspace : null;
      if (uri) map.set(id, uriToPath(uri));
    } catch {
      // no workspace.json (untitled / remote workspace)
    }
  }
  return map;
}

const TERMINAL_TOOL = /^(?:run_terminal_(?:cmd|commands?|command_v2)|run_test|Shell|shell)$/;
const EDIT_TOOL = /^(?:edit_file(?:_v2)?|search_replace|new_file|reapply|delete_file|apply_agent_diff|new_edit|save_file|create_rm_files|undo_edit|Write|StrReplace|Edit|MultiEdit|edit|delete|Delete)$/;

export interface CursorComposer {
  id: string;
  /** Workspace folder resolved from the composer index, a workspace DB or the composer row; null when nothing maps it. */
  project: string | null;
  createdAt: number;
  updatedAt: number;
  subagent: boolean;
  agentic: boolean;
  /** Bubble ids in conversation order (fullConversationHeadersOnly), possibly empty. */
  order: string[];
}

export interface CursorStore {
  path: string;
  composers(): CursorComposer[];
  scan(c: CursorComposer, opts: { since?: Date | null }, label: string, out: ClaimRecord[], stats: TurnStats): void;
  close(): void;
}

function openDb(sqlite: SqliteModule, path: string): SqliteDb {
  try {
    // timeout = busy timeout; Cursor checkpoints its WAL while running.
    return new sqlite.DatabaseSync(path, { readOnly: true, timeout: 2000 });
  } catch {
    return new sqlite.DatabaseSync(path, { readOnly: true });
  }
}

/** Composer id -> workspace folder, from the Cursor 3.0+ global index and from every older per-workspace DB. */
function composerProjects(sqlite: SqliteModule, db: SqliteDb, userDir: string, folders: Map<string, string>): { projects: Map<string, string>; subagents: Set<string> } {
  const projects = new Map<string, string>();
  const subagents = new Set<string>();
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get();
    const j = row ? valueJson(row.value) : null;
    for (const c of Array.isArray(j?.allComposers) ? (j.allComposers as unknown[]) : []) {
      const h = obj(c);
      const id = typeof h?.composerId === 'string' ? h.composerId : null;
      if (!h || !id) continue;
      if (h.isSubagent === true) subagents.add(id);
      const wi = obj(h.workspaceIdentifier);
      const uri = obj(wi?.uri);
      const p = typeof uri?.fsPath === 'string' ? uri.fsPath : typeof uri?.external === 'string' ? uriToPath(uri.external) : typeof wi?.id === 'string' ? (folders.get(wi.id) ?? null) : null;
      if (p) projects.set(id, p);
    }
  } catch {
    // no index (pre-3.0)
  }
  // Cursor <= 2.6: each workspace DB lists its own composers.
  for (const [id, folder] of folders) {
    const p = join(userDir, 'workspaceStorage', id, 'state.vscdb');
    if (!existsSync(p)) continue;
    let wdb: SqliteDb | null = null;
    try {
      wdb = openDb(sqlite, p);
      const row = wdb.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
      const j = row ? valueJson(row.value) : null;
      for (const c of Array.isArray(j?.allComposers) ? (j.allComposers as unknown[]) : []) {
        const cid = obj(c)?.composerId;
        if (typeof cid === 'string' && !projects.has(cid)) projects.set(cid, folder);
      }
    } catch {
      // locked or unreadable workspace DB: its composers keep whatever the global index said
    } finally {
      try {
        wdb?.close();
      } catch {
        // ignore
      }
    }
  }
  return { projects, subagents };
}

/** Bubble time: createdAt (ISO), else the client timing fields (ms), else the caller's fallback. */
function bubbleAt(b: Rec, fallback: number): number {
  const t = ts(b.createdAt);
  if (t > 1e12) return t;
  const ti = obj(b.timingInfo);
  for (const k of ['clientRpcSendTime', 'clientSettleTime', 'clientEndTime', 'clientStartTime']) {
    const v = ti?.[k];
    if (typeof v === 'number' && v > 1e12) return v;
  }
  return fallback;
}

function commandText(params: Rec | null): string {
  const c = params?.command ?? params?.cmd ?? params?.commands;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(String).join(' && ');
  return '';
}

/** Feed one bubble to the tracker: user prompts bound turns, assistant text is the claim, toolFormerData carries edits/commands. */
function feedBubble(turn: TurnTracker, b: Rec, at: number): void {
  if (b.type === 1) {
    turn.finalize();
    turn.prompt();
    return;
  }
  if (b.type !== 2) return;
  const tf = obj(b.toolFormerData);
  const toolId = typeof tf?.tool === 'number' ? tf.tool : typeof tf?.tool === 'string' ? Number(tf.tool) : NaN;
  const name = typeof tf?.name === 'string' ? tf.name : '';
  // ~6% of bubbles carry a placeholder toolFormerData {additionalData:{status:'error'}} with no tool and no name.
  if (tf && (name || Number.isFinite(toolId))) {
    const status = typeof tf.status === 'string' ? tf.status : typeof obj(tf.additionalData)?.status === 'string' ? (obj(tf.additionalData)?.status as string) : undefined;
    const params = parseJson(tf.params ?? tf.rawArgs);
    const result = parseJson(tf.result);
    if (toolId === 15 || TERMINAL_TOOL.test(name)) {
      const cmd = commandText(params);
      const declined = tf.userDecision === 'rejected' || result?.rejected === true || status === 'cancelled';
      if (cmd && !declined) {
        const code = typeof result?.exitCodeV2 === 'number' ? result.exitCodeV2 : typeof result?.exitCode === 'number' ? result.exitCode : null;
        if (code !== null) turn.ran(cmd, code === 0, at);
        else if (status === 'error') turn.ran(cmd, false, at);
        else if (result?.notInterrupted !== false && status !== 'running') turn.ran(cmd, null, at);
      }
    } else if (toolId === 38 || toolId === 11 || EDIT_TOOL.test(name)) {
      if (status === 'completed' || (status === undefined && tf.result != null)) turn.edit(at);
    }
  }
  if (b.capabilityType === 30) return; // thinking bubble
  if (typeof b.text === 'string' && b.text.trim()) turn.text(b.text, at);
}

/**
 * Open the bubble store read-only. Returns null when node:sqlite is unavailable (pass `sqlite: null` to force that)
 * or the DB does not exist; throws when it exists but cannot be opened (locked, corrupt), so the caller can fall back.
 */
export function openCursorStore(userDir: string, opts: { sqlite?: SqliteModule | null } = {}): CursorStore | null {
  const path = join(userDir, 'globalStorage', 'state.vscdb');
  if (!existsSync(path)) return null; // checked first: no Cursor install means node:sqlite is never loaded
  const sqlite = opts.sqlite === undefined ? loadSqlite() : opts.sqlite;
  if (!sqlite) return null;
  const db = openDb(sqlite, path);
  const folders = workspaceFolders(userDir);
  const { projects, subagents } = composerProjects(sqlite, db, userDir, folders);
  return {
    path,
    composers(): CursorComposer[] {
      const list: CursorComposer[] = [];
      const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'").all();
      for (const row of rows) {
        const id = String(row.key).slice('composerData:'.length);
        const cd = valueJson(row.value);
        if (!id || !cd) continue;
        const wi = obj(cd.workspaceIdentifier);
        const uri = obj(wi?.uri);
        const worktree = obj(cd.gitWorktree)?.worktreePath;
        let project: string | null = projects.get(id) ?? null;
        if (project === null && typeof uri?.fsPath === 'string') project = uri.fsPath;
        if (project === null && typeof wi?.id === 'string') project = folders.get(wi.id) ?? null;
        if (project === null && typeof worktree === 'string') project = worktree;
        const order: string[] = [];
        for (const h of Array.isArray(cd.fullConversationHeadersOnly) ? (cd.fullConversationHeadersOnly as unknown[]) : []) {
          const bid = obj(h)?.bubbleId;
          if (typeof bid === 'string') order.push(bid);
        }
        const mode = typeof cd.unifiedMode === 'string' ? cd.unifiedMode : null;
        list.push({
          id,
          project,
          createdAt: ts(cd.createdAt),
          updatedAt: ts(cd.lastUpdatedAt) || ts(cd.createdAt),
          subagent: id.startsWith('task-') || cd.isSubagent === true || subagents.has(id),
          // Chat-mode composers never edit files; unknown modes (older rows) are scanned.
          agentic: cd.isAgentic === true || mode === null || mode === 'agent',
          order,
        });
      }
      return list;
    },
    scan(c, opts2, label, out, stats): void {
      const turn = new TurnTracker({ project: () => label, session: c.id, agent: 'cursor', sinceMs: opts2.since ? opts2.since.getTime() : 0 }, out, stats);
      const rows = db.prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?').all(`bubbleId:${c.id}:`, `bubbleId:${c.id};`);
      const index = new Map<string, number>();
      c.order.forEach((bid, i) => index.set(bid, i));
      const bubbles: Array<{ b: Rec; at: number; pos: number }> = [];
      for (const row of rows) {
        const b = valueJson(row.value);
        if (!b) continue;
        const bid = typeof b.bubbleId === 'string' ? b.bubbleId : String(row.key).split(':').pop() ?? '';
        const pos = index.get(bid) ?? Number.MAX_SAFE_INTEGER;
        bubbles.push({ b, at: bubbleAt(b, 0), pos });
      }
      // Manifest order when known (rows may be collapsed fragments), else creation time.
      bubbles.sort((x, y) => (x.pos !== y.pos ? x.pos - y.pos : x.at - y.at));
      let last = c.createdAt;
      for (const { b, at } of bubbles) {
        const t = at || ++last;
        last = Math.max(last, t);
        feedBubble(turn, b, t);
      }
      turn.finalize();
    },
    close(): void {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}

/** Project label for a ~/.cursor/projects/<slug> dir: repo.json (workspace / rootPath / path) or the slug itself. */
function transcriptProjectLabel(dir: string, slug: string): string {
  try {
    const j = obj(JSON.parse(readFileSync(join(dir, 'repo.json'), 'utf8')));
    for (const k of ['workspace', 'rootPath', 'path']) {
      const v = j?.[k];
      if (typeof v === 'string' && v) return v;
    }
  } catch {
    // no repo.json; the slug keeps every path character except separators, so it stays recognisable and excludable
  }
  return `cursor:${slug}`;
}

/** Agent transcripts under <cursorDir>/projects/<slug>/agent-transcripts: <id>/<id>.jsonl (IDE), <id>.jsonl (CLI), subagents/. */
export function cursorTranscriptFiles(cursorDir: string, since: Date | null, includeSubagents = false): { files: AgentSessionFile[]; skipped: number } {
  const files: AgentSessionFile[] = [];
  let skipped = 0;
  const projects = join(cursorDir, 'projects');
  if (!isDir(projects)) return { files, skipped };
  const consider = (p: string, slug: string, label: string) => {
    try {
      if (since && statSync(p).mtimeMs < since.getTime()) skipped++;
      else files.push({ file: p, slug, label });
    } catch {
      skipped++;
    }
  };
  const walk = (dir: string, slug: string, label: string, depth: number) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e.endsWith('.jsonl')) {
        if (!isDir(p)) consider(p, slug, label);
      } else if (depth < 2 && isDir(p)) {
        if (e === 'subagents' && !includeSubagents) continue;
        walk(p, slug, label, depth + 1);
      }
    }
  };
  for (const slug of readdirSync(projects)) {
    const dir = join(projects, slug);
    const transcripts = join(dir, 'agent-transcripts');
    if (!isDir(transcripts)) continue;
    walk(transcripts, slug, transcriptProjectLabel(dir, slug), 0);
  }
  return { files, skipped };
}

/** Composer id of a transcript file (its basename), so sessions already read from the bubble store are not counted twice. */
export function transcriptComposerId(file: string): string {
  return basename(file, '.jsonl');
}

/**
 * The lossy JSONL transcript: {role, message:{content:[{type:'text'|'tool_use', ...}]}} per line, no tool results, no
 * timestamps. Lines are timed backwards from the file's mtime so ordering and `since` still work.
 */
export function scanCursorTranscript(file: string, opts: { since?: Date | null }, label: string, out: ClaimRecord[], stats: TurnStats): void {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const mtime = statSync(file).mtimeMs;
  const turn = new TurnTracker({ project: () => label, session: transcriptComposerId(file), agent: 'cursor', sinceMs: opts.since ? opts.since.getTime() : 0, lossy: true }, out, stats);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith('{')) continue;
    let j: Rec;
    try {
      j = JSON.parse(line) as Rec;
    } catch {
      continue;
    }
    const at = mtime - (lines.length - 1 - i);
    const content = obj(j.message)?.content;
    const blocks = Array.isArray(content) ? (content as unknown[]) : [];
    if (j.role === 'user') {
      turn.finalize();
      turn.prompt();
    } else if (j.role === 'assistant') {
      const texts: string[] = [];
      for (const blk of blocks) {
        const b = obj(blk);
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text.replace(/\[REDACTED\]/g, ' '));
        if (b.type === 'tool_use') {
          const name = typeof b.name === 'string' ? b.name : '';
          const input = obj(b.input);
          if (EDIT_TOOL.test(name)) turn.edit(at);
          else if (TERMINAL_TOOL.test(name)) {
            const cmd = commandText(input);
            if (cmd) turn.ran(cmd, null, at); // no result in this store: exit status unknown
          }
        }
      }
      const text = texts.join('\n');
      if (text.trim()) turn.text(text, at);
    }
  }
  turn.finalize();
}
