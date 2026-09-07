/**
 * `isitdone history`: a retrospective over local Claude Code transcripts.
 * For every turn in which the agent edited files, look at its final message: if it claims completion,
 * was a test command actually run (and did it pass) after the last edit?
 *
 * Reads ~/.claude/projects/<slug>/<session>.jsonl locally. Nothing leaves the machine. Only aggregate
 * counts and (with --verbose) the quoted claim sentence are reported; no prompts, code or tool output.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { findClaim } from './claims.js';

export type Verdict = 'VERIFIED' | 'STALE' | 'FAILED' | 'NEVER_RAN';

export interface ClaimRecord {
  project: string;
  session: string;
  at: string;
  verdict: Verdict;
  claim: string;
  pattern: string;
  edits: number;
  testRuns: number;
  /** Non-test verification commands (typecheck, lint, build) in the turn. */
  checkRuns: number;
}

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
  scannedFiles: number;
  skippedFiles: number;
  excludedDirs: string[];
  sessions: number;
  /** Turns with at least one edit. */
  editTurns: number;
  claims: ClaimRecord[];
  counts: Record<Verdict, number>;
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
  since?: Date | null;
  /** Case-insensitive substrings; a project directory or path containing one is skipped. */
  exclude?: string[];
  includeSubagents?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_editor', 'str_replace_based_edit_tool', 'create_file', 'apply_patch']);
const TEST_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:\w+|jest|vitest|e2e)\b|\b(?:npx\s+|pnpm\s+|yarn\s+|bunx\s+)?(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|unittest|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|make\s+(?:test|tests|check)|gradle\w*\s+test|mvnw?\s+.*\btest\b|rspec|phpunit|mix\s+test|swift\s+test|isitdone)\b/;
const CHECK_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|lint|check|build|verify|validate)\b|\b(?:npx\s+)?(?:tsc|eslint|biome|ruff|mypy|pyright|flake8|go\s+(?:vet|build)|cargo\s+(?:check|clippy|build)|dotnet\s+build)\b/;
const SHELL_EDIT = /\bsed\s+-i\b|\btee\b|\bcat\s*>|(?:^|[^>2&])>\s*[^&\s]|\bmv\s|\bcp\s|\bpatch\b|\bgit\s+(?:checkout|restore|stash|revert|cherry-pick|merge|rebase|apply)\b/;

interface Turn {
  edits: number;
  lastEditAt: number;
  testRuns: number;
  checkRuns: number;
  lastTest: { at: number; ok: boolean } | null;
  lastAssistantText: string;
  lastAssistantAt: number;
  pending: Map<string, { kind: 'test' | 'check'; at: number }>;
}

function newTurn(): Turn {
  return { edits: 0, lastEditAt: 0, testRuns: 0, checkRuns: 0, lastTest: null, lastAssistantText: '', lastAssistantAt: 0, pending: new Map() };
}

function ts(v: unknown): number {
  const n = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Decode a project slug like "C--Users-me-work-app" into something readable; prefer the cwd field when seen. */
export function projectLabel(slug: string, cwd: string | null): string {
  if (cwd) return cwd;
  return slug.replace(/^([A-Za-z])--/, '$1:/').replace(/^-/, '/').replace(/-/g, '/');
}

export async function scanSession(file: string, opts: { includeSubagents?: boolean; since?: Date | null }, project: { label: string; sawCwd: (cwd: string) => void }, out: ClaimRecord[], stats: { editTurns: number }): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let turn = newTurn();
  const sinceMs = opts.since ? opts.since.getTime() : 0;
  const session = basename(file, '.jsonl');
  let cwd: string | null = null;

  const finalize = () => {
    if (turn.edits === 0 && turn.testRuns === 0) return;
    if (turn.edits > 0) stats.editTurns++;
    const claim = findClaim(turn.lastAssistantText);
    if (!claim || turn.edits === 0) return;
    if (sinceMs && turn.lastAssistantAt < sinceMs) return;
    let verdict: Verdict;
    if (turn.testRuns === 0 || !turn.lastTest) verdict = 'NEVER_RAN';
    else if (!turn.lastTest.ok) verdict = 'FAILED';
    else if (turn.lastEditAt > turn.lastTest.at) verdict = 'STALE';
    else verdict = 'VERIFIED';
    out.push({ project: cwd ?? project.label, session, at: new Date(turn.lastAssistantAt || 0).toISOString(), verdict, claim: claim.sentence, pattern: claim.pattern, edits: turn.edits, testRuns: turn.testRuns, checkRuns: turn.checkRuns });
  };

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
          const p = turn.pending.get(id);
          if (!p) continue;
          turn.pending.delete(id);
          const ok = b.is_error !== true;
          if (p.kind === 'test') {
            turn.testRuns++;
            turn.lastTest = { at: at || p.at, ok };
          } else {
            turn.checkRuns++;
          }
        }
        continue;
      }
      // A real user prompt starts a new turn.
      finalize();
      turn = newTurn();
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
          if (EDIT_TOOLS.has(name)) {
            turn.edits++;
            turn.lastEditAt = at;
          } else if (name === 'Bash' || name === 'PowerShell' || name === 'bash' || name === 'shell' || name === 'exec_command') {
            const cmd = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
            if (TEST_CMD.test(cmd)) turn.pending.set(id, { kind: 'test', at });
            else if (CHECK_CMD.test(cmd)) turn.pending.set(id, { kind: 'check', at });
            else if (SHELL_EDIT.test(cmd)) {
              turn.edits++;
              turn.lastEditAt = at;
            }
          }
        }
      }
      if (texts.length > 0) {
        turn.lastAssistantText = texts.join('\n');
        turn.lastAssistantAt = at;
      }
    }
  }
  finalize();
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

export async function scanHistory(opts: HistoryOptions = {}): Promise<HistoryReport> {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const exclude = (opts.exclude ?? []).map((e) => e.toLowerCase()).filter(Boolean);
  const since = opts.since ?? null;
  const report: HistoryReport = {
    projectsDir,
    scannedFiles: 0,
    skippedFiles: 0,
    excludedDirs: [],
    sessions: 0,
    editTurns: 0,
    claims: [],
    counts: { VERIFIED: 0, STALE: 0, FAILED: 0, NEVER_RAN: 0 },
    verifiedPct: 0,
    unbackedPct: 0,
    byProject: [],
    since: since ? since.toISOString() : null,
  };
  if (!existsSync(projectsDir)) return report;

  const files: Array<{ file: string; slug: string }> = [];
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
          files.push({ file: p, slug });
        } else if (st.isDirectory() && opts.includeSubagents) {
          const sub = join(p, 'subagents');
          if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith('.jsonl')) files.push({ file: join(sub, s), slug });
        }
      } catch {
        report.skippedFiles++;
      }
    }
  }

  const labels = new Map<string, string>();
  const stats = { editTurns: 0 };
  let done = 0;
  for (const { file, slug } of files) {
    const project = {
      label: labels.get(slug) ?? projectLabel(slug, null),
      sawCwd: (cwd: string) => {
        if (!labels.has(slug)) labels.set(slug, cwd);
      },
    };
    try {
      await scanSession(file, { includeSubagents: opts.includeSubagents, since }, project, report.claims, stats);
      report.scannedFiles++;
      report.sessions++;
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
