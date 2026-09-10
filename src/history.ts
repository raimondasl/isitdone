/**
 * `isitdone history`: a retrospective over local coding-agent transcripts (Claude Code, Codex CLI, Gemini CLI, Qwen Code,
 * Cursor). For every turn in which the agent edited files, look at its final message: if it claims completion,
 * was a test command actually run (and did it pass) after the last edit?
 *
 * Reads transcripts locally. Nothing leaves the machine. Only aggregate counts and (with --verbose) the quoted
 * claim sentence are reported; no prompts, code or tool output.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { codexSessionFiles, scanCodexSession } from './codex.js';
import { cursorTranscriptFiles, defaultCursorDir, defaultCursorUserDir, openCursorStore, scanCursorTranscript, transcriptComposerId, type CursorComposer, type CursorStore } from './cursor.js';
import { defaultGeminiDir, defaultQwenDir, geminiSessionFiles, qwenSessionFiles, scanGeminiSession, scanQwenSession } from './gemini.js';
import { TurnTracker, ts, type ClaimRecord, type TurnStats, type Verdict } from './turns.js';

export type { ClaimRecord, Verdict } from './turns.js';

export interface ProjectStats {
  project: string;
  claims: number;
  verified: number;
  stale: number;
  failed: number;
  neverRan: number;
  /** Share of claims with no passing test run after the last edit (stale + failed + never ran). */
  unbackedPct: number;
}

export interface AgentStats {
  sessions: number;
  claims: number;
  verified: number;
  /** Sessions whose transcript carries no exit codes (Cursor agent-transcripts): their test runs were assumed to pass. */
  lossy?: number;
}

export interface HistoryReport {
  projectsDir: string;
  codexDir: string | null;
  geminiDir: string | null;
  qwenDir: string | null;
  /** ~/.cursor (agent-transcripts JSONL). */
  cursorDir: string | null;
  /** Cursor's user-data dir holding globalStorage/state.vscdb. */
  cursorUserDir: string | null;
  /** How Cursor sessions were read: the SQLite bubble store, the lossy JSONL transcripts, or neither found. */
  cursorSource: 'sqlite' | 'transcripts' | 'sqlite+transcripts' | null;
  scannedFiles: number;
  skippedFiles: number;
  excludedDirs: string[];
  sessions: number;
  /** Turns with at least one edit. */
  editTurns: number;
  claims: ClaimRecord[];
  counts: Record<Verdict, number>;
  byAgent: Record<string, AgentStats>;
  /** Share of claims that were VERIFIED. */
  verifiedPct: number;
  /** Share of claims with no passing test run after the last edit. */
  unbackedPct: number;
  byProject: ProjectStats[];
  since: string | null;
}

export interface HistoryOptions {
  /** Override ~/.claude/projects (tests). */
  projectsDir?: string;
  /** Override $CODEX_HOME / ~/.codex (tests). Pass null to skip Codex. */
  codexDir?: string | null;
  /** Override $GEMINI_CLI_HOME/.gemini / ~/.gemini (tests). Pass null to skip Gemini CLI. */
  geminiDir?: string | null;
  /** Override $QWEN_HOME / ~/.qwen (tests). Pass null to skip Qwen Code. */
  qwenDir?: string | null;
  /** Override ~/.cursor (tests). Pass null to skip Cursor agent-transcripts. */
  cursorDir?: string | null;
  /** Override Cursor's user-data dir (tests). Pass null to skip the SQLite bubble store. */
  cursorUserDir?: string | null;
  /** false: never load node:sqlite, read Cursor's JSONL transcripts only (tests). */
  cursorSqlite?: boolean;
  since?: Date | null;
  /** Case-insensitive substrings; a project directory or path containing one is skipped. */
  exclude?: string[];
  includeSubagents?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_editor', 'str_replace_based_edit_tool', 'create_file', 'apply_patch']);

/** Decode a project slug like "C--Users-me-work-app" into something readable; prefer the cwd field when seen. */
export function projectLabel(slug: string, cwd: string | null): string {
  if (cwd) return cwd;
  return slug.replace(/^([A-Za-z])--/, '$1:/').replace(/^-/, '/').replace(/-/g, '/');
}

export async function scanSession(file: string, opts: { includeSubagents?: boolean; since?: Date | null }, project: { label: string; sawCwd: (cwd: string) => void }, out: ClaimRecord[], stats: TurnStats): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const session = basename(file, '.jsonl');
  let cwd: string | null = null;
  const turn = new TurnTracker({ project: () => cwd ?? project.label, session, agent: 'claude-code', sinceMs: opts.since ? opts.since.getTime() : 0 }, out, stats);

  for await (const line of rl) {
    if (!line.startsWith('{')) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (j.isSidechain === true && !opts.includeSubagents) continue;
    if (typeof j.cwd === 'string' && j.cwd) {
      if (!cwd) project.sawCwd(j.cwd);
      cwd = j.cwd;
    }
    const type = j.type;
    const at = ts(j.timestamp);
    const message = j.message as { role?: string; content?: unknown } | undefined;
    if (type === 'user' && message) {
      const content = message.content;
      const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : null;
      const isToolResult = blocks !== null && blocks.some((b) => b && b.type === 'tool_result');
      if (isToolResult) {
        for (const b of blocks as Array<Record<string, unknown>>) {
          if (!b || b.type !== 'tool_result') continue;
          const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
          turn.resolve(id, b.is_error !== true, at);
        }
        continue;
      }
      // A real user prompt starts a new turn.
      turn.finalize();
      turn.prompt();
      continue;
    }
    if (type === 'assistant' && message && Array.isArray(message.content)) {
      const texts: string[] = [];
      for (const b of message.content as Array<Record<string, unknown>>) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        if (b.type === 'tool_use') {
          const name = typeof b.name === 'string' ? b.name : '';
          const input = (b.input ?? {}) as Record<string, unknown>;
          const id = typeof b.id === 'string' ? b.id : '';
          if (EDIT_TOOLS.has(name)) turn.edit(at);
          else if (name === 'Bash' || name === 'PowerShell' || name === 'bash' || name === 'shell' || name === 'exec_command') {
            const cmd = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
            turn.command(id, cmd, at);
          }
        }
      }
      if (texts.length > 0) turn.text(texts.join('\n'), at);
    }
  }
  turn.finalize();
  // Release the file handle before returning (Windows cannot delete a directory with an open stream).
  rl.close();
  await new Promise<void>((resolve) => {
    if (stream.destroyed || stream.closed) return resolve();
    stream.once('close', () => resolve());
    stream.destroy();
  });
}

export function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

export function defaultCodexDir(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME !== '' ? process.env.CODEX_HOME : join(homedir(), '.codex');
}

type Agent = ClaimRecord['agent'];

/** One unit of work for the scan loop: a transcript file, or a Cursor composer read from the open bubble store. */
type Item =
  | { kind: 'file'; agent: Agent; file: string; slug: string; label: string }
  | { kind: 'cursor-db'; agent: 'cursor'; composer: CursorComposer; label: string; store: CursorStore };

export async function scanHistory(opts: HistoryOptions = {}): Promise<HistoryReport> {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const codexDir = opts.codexDir === undefined ? defaultCodexDir() : opts.codexDir;
  const geminiDir = opts.geminiDir === undefined ? defaultGeminiDir() : opts.geminiDir;
  const qwenDir = opts.qwenDir === undefined ? defaultQwenDir() : opts.qwenDir;
  const cursorDir = opts.cursorDir === undefined ? defaultCursorDir() : opts.cursorDir;
  const cursorUserDir = opts.cursorUserDir === undefined ? defaultCursorUserDir() : opts.cursorUserDir;
  const exclude = (opts.exclude ?? []).map((e) => e.toLowerCase()).filter(Boolean);
  const since = opts.since ?? null;
  const report: HistoryReport = {
    projectsDir,
    codexDir,
    geminiDir,
    qwenDir,
    cursorDir,
    cursorUserDir,
    cursorSource: null,
    scannedFiles: 0,
    skippedFiles: 0,
    excludedDirs: [],
    sessions: 0,
    editTurns: 0,
    claims: [],
    counts: { VERIFIED: 0, STALE: 0, FAILED: 0, NEVER_RAN: 0 },
    byAgent: {},
    verifiedPct: 0,
    unbackedPct: 0,
    byProject: [],
    since: since ? since.toISOString() : null,
  };
  const excludedDirs = new Set<string>();
  /** True (and remembered for the report) when a project dir or label matches an exclusion. */
  const excluded = (...names: string[]): boolean => {
    const hit = names.find((n) => exclude.some((e) => n.toLowerCase().includes(e)));
    if (hit === undefined) return false;
    excludedDirs.add(names[0] as string);
    return true;
  };

  const items: Item[] = [];
  if (existsSync(projectsDir)) {
    for (const slug of readdirSync(projectsDir)) {
      const dir = join(projectsDir, slug);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (excluded(slug)) continue;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          if (st.isFile() && f.endsWith('.jsonl')) {
            if (since && st.mtimeMs < since.getTime()) {
              report.skippedFiles++;
              continue;
            }
            items.push({ kind: 'file', agent: 'claude-code', file: p, slug, label: projectLabel(slug, null) });
          } else if (st.isDirectory() && opts.includeSubagents) {
            const sub = join(p, 'subagents');
            if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith('.jsonl')) items.push({ kind: 'file', agent: 'claude-code', file: join(sub, s), slug, label: projectLabel(slug, null) });
          }
        } catch {
          report.skippedFiles++;
        }
      }
    }
  }
  if (codexDir) {
    const { files: codexFiles, skipped } = codexSessionFiles(codexDir, since);
    report.skippedFiles += skipped;
    for (const f of codexFiles) items.push({ kind: 'file', agent: 'codex', file: f, slug: 'codex', label: 'codex' });
  }
  if (geminiDir) {
    const { files, skipped } = geminiSessionFiles(geminiDir, since, opts.includeSubagents);
    report.skippedFiles += skipped;
    for (const f of files) if (!excluded(f.slug, f.label)) items.push({ kind: 'file', agent: 'gemini', ...f });
  }
  if (qwenDir) {
    const { files, skipped } = qwenSessionFiles(qwenDir, since);
    report.skippedFiles += skipped;
    for (const f of files) if (!excluded(f.slug, f.label)) items.push({ kind: 'file', agent: 'qwen', ...f });
  }
  // Cursor: the bubble store when node:sqlite can open it, then any JSONL transcript it did not already cover (Cursor CLI
  // sessions live only in the JSONL; IDE sessions are in both, and the store has the exit codes).
  let store: CursorStore | null = null;
  const covered = new Set<string>();
  if (cursorUserDir && opts.cursorSqlite !== false) {
    try {
      store = openCursorStore(cursorUserDir);
    } catch {
      store = null; // locked or unreadable: fall back to the transcripts
      report.skippedFiles++;
    }
    if (store) {
      report.cursorSource = 'sqlite';
      try {
        for (const c of store.composers()) {
          // A composer whose workspace cannot be resolved cannot be matched against --exclude; leave it to its JSONL twin,
          // whose project slug can (exit codes are lost there, which the report says).
          if (!c.project) continue;
          covered.add(c.id);
          if (!c.agentic || (c.subagent && !opts.includeSubagents)) continue;
          if (since && c.updatedAt && c.updatedAt < since.getTime()) {
            report.skippedFiles++;
            continue;
          }
          const label = c.project;
          if (excluded(label)) continue;
          items.push({ kind: 'cursor-db', agent: 'cursor', composer: c, label, store });
        }
      } catch {
        // SQLite opens lazily: a locked, corrupt or foreign-schema store fails on the first query. Fall back to the transcripts.
        try {
          store.close();
        } catch {
          // ignore
        }
        store = null;
        covered.clear();
        report.cursorSource = null;
        report.skippedFiles++;
        for (let k = items.length - 1; k >= 0; k--) if (items[k]?.kind === 'cursor-db') items.splice(k, 1);
      }
    }
  }
  if (cursorDir) {
    const { files, skipped } = cursorTranscriptFiles(cursorDir, since, opts.includeSubagents);
    report.skippedFiles += skipped;
    let added = 0;
    for (const f of files) {
      if (covered.has(transcriptComposerId(f.file)) || excluded(f.slug, f.label)) continue;
      items.push({ kind: 'file', agent: 'cursor', ...f });
      added++;
    }
    if (added > 0) report.cursorSource = store ? 'sqlite+transcripts' : 'transcripts';
  }

  const labels = new Map<string, string>();
  const stats: TurnStats = { editTurns: 0 };
  let done = 0;
  for (const item of items) {
    const agent = item.agent;
    const before = report.claims.length;
    let lossy = false;
    try {
      if (item.kind === 'cursor-db') {
        item.store.scan(item.composer, { since }, item.label, report.claims, stats);
      } else if (agent === 'codex') await scanCodexSession(item.file, { since }, report.claims, stats);
      else if (agent === 'gemini') await scanGeminiSession(item.file, { since, includeSubagents: opts.includeSubagents }, item.label, report.claims, stats);
      else if (agent === 'qwen') {
        const key = `qwen:${item.slug}`;
        await scanQwenSession(item.file, { since, includeSubagents: opts.includeSubagents }, { label: labels.get(key) ?? item.label, sawCwd: (cwd) => labels.set(key, cwd) }, report.claims, stats);
      } else if (agent === 'cursor') {
        scanCursorTranscript(item.file, { since }, item.label, report.claims, stats);
        lossy = true;
      } else {
        const project = {
          label: labels.get(item.slug) ?? item.label,
          sawCwd: (cwd: string) => {
            if (!labels.has(item.slug)) labels.set(item.slug, cwd);
          },
        };
        await scanSession(item.file, { includeSubagents: opts.includeSubagents, since }, project, report.claims, stats);
      }
      report.scannedFiles++;
      report.sessions++;
      const a = (report.byAgent[agent] = report.byAgent[agent] ?? { sessions: 0, claims: 0, verified: 0 });
      a.sessions++;
      a.claims += report.claims.length - before;
      a.verified += report.claims.slice(before).filter((c) => c.verdict === 'VERIFIED').length;
      if (lossy) a.lossy = (a.lossy ?? 0) + 1;
    } catch {
      report.claims.length = before;
      report.skippedFiles++;
    }
    done++;
    opts.onProgress?.(done, items.length);
  }
  store?.close();
  report.excludedDirs = [...excludedDirs];
  // Exclusions may also match a cwd rather than the slug.
  if (exclude.length > 0) {
    const kept = report.claims.filter((c) => !exclude.some((e) => c.project.toLowerCase().includes(e)));
    if (kept.length !== report.claims.length) {
      for (const c of report.claims) {
        if (kept.includes(c)) continue;
        const a = report.byAgent[c.agent];
        if (a) {
          a.claims--;
          if (c.verdict === 'VERIFIED') a.verified--;
        }
      }
      report.claims = kept;
    }
  }
  report.editTurns = stats.editTurns;
  for (const c of report.claims) report.counts[c.verdict]++;
  const total = report.claims.length;
  report.verifiedPct = total ? Math.round((100 * report.counts.VERIFIED) / total) : 0;
  report.unbackedPct = total ? Math.round((100 * (total - report.counts.VERIFIED)) / total) : 0;

  const by = new Map<string, ProjectStats>();
  for (const c of report.claims) {
    const s = by.get(c.project) ?? { project: c.project, claims: 0, verified: 0, stale: 0, failed: 0, neverRan: 0, unbackedPct: 0 };
    s.claims++;
    if (c.verdict === 'VERIFIED') s.verified++;
    else if (c.verdict === 'STALE') s.stale++;
    else if (c.verdict === 'FAILED') s.failed++;
    else s.neverRan++;
    by.set(c.project, s);
  }
  report.byProject = [...by.values()]
    .map((s) => ({ ...s, unbackedPct: Math.round((100 * (s.claims - s.verified)) / s.claims) }))
    .sort((a, b) => b.claims - a.claims);
  return report;
}

export function parseSince(v: string): Date | null {
  const m = /^(\d+)\s*([dwmh])$/i.exec(v.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] as string).toLowerCase();
    const ms = unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : unit === 'w' ? 7 * 86_400_000 : 30 * 86_400_000;
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
