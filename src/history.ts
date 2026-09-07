/**
 * `isitdone history`: a retrospective over local coding-agent transcripts (Claude Code, Codex CLI).
 * For every turn in which the agent edited files, look at its final message: if it claims completion,
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

export interface HistoryReport {
  projectsDir: string;
  codexDir: string | null;
  scannedFiles: number;
  skippedFiles: number;
  excludedDirs: string[];
  sessions: number;
  /** Turns with at least one edit. */
  editTurns: number;
  claims: ClaimRecord[];
  counts: Record<Verdict, number>;
  byAgent: Record<string, { sessions: number; claims: number; verified: number }>;
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

export async function scanHistory(opts: HistoryOptions = {}): Promise<HistoryReport> {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const codexDir = opts.codexDir === undefined ? defaultCodexDir() : opts.codexDir;
  const exclude = (opts.exclude ?? []).map((e) => e.toLowerCase()).filter(Boolean);
  const since = opts.since ?? null;
  const report: HistoryReport = {
    projectsDir,
    codexDir,
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

  const files: Array<{ file: string; slug: string; agent: 'claude-code' | 'codex' }> = [];
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
      if (exclude.some((e) => slug.toLowerCase().includes(e))) {
        report.excludedDirs.push(slug);
        continue;
      }
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          if (st.isFile() && f.endsWith('.jsonl')) {
            if (since && st.mtimeMs < since.getTime()) {
              report.skippedFiles++;
              continue;
            }
            files.push({ file: p, slug, agent: 'claude-code' });
          } else if (st.isDirectory() && opts.includeSubagents) {
            const sub = join(p, 'subagents');
            if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith('.jsonl')) files.push({ file: join(sub, s), slug, agent: 'claude-code' });
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
    for (const f of codexFiles) files.push({ file: f, slug: 'codex', agent: 'codex' });
  }

  const labels = new Map<string, string>();
  const stats: TurnStats = { editTurns: 0 };
  let done = 0;
  for (const { file, slug, agent } of files) {
    const project = {
      label: labels.get(slug) ?? (agent === 'codex' ? 'codex' : projectLabel(slug, null)),
      sawCwd: (cwd: string) => {
        if (agent !== 'codex' && !labels.has(slug)) labels.set(slug, cwd);
      },
    };
    try {
      const before = report.claims.length;
      if (agent === 'codex') await scanCodexSession(file, { since }, report.claims, stats);
      else await scanSession(file, { includeSubagents: opts.includeSubagents, since }, project, report.claims, stats);
      report.scannedFiles++;
      report.sessions++;
      const a = (report.byAgent[agent] = report.byAgent[agent] ?? { sessions: 0, claims: 0, verified: 0 });
      a.sessions++;
      a.claims += report.claims.length - before;
      a.verified += report.claims.slice(before).filter((c) => c.verdict === 'VERIFIED').length;
    } catch {
      report.skippedFiles++;
    }
    done++;
    opts.onProgress?.(done, files.length);
  }
  // Exclusions may also match a cwd rather than the slug.
  report.claims = report.claims.filter((c) => !exclude.some((e) => c.project.toLowerCase().includes(e)));
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
