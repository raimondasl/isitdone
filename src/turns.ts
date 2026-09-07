/**
 * Turn bookkeeping shared by the transcript parsers (Claude Code, Codex): per user turn, did the agent edit files,
 * run tests, and what did it say last. `finalize()` classifies the turn's completion claim.
 */
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
  /** Which agent wrote the transcript. */
  agent: 'claude-code' | 'codex';
}

export const TEST_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:\w+|jest|vitest|e2e)\b|\b(?:npx\s+|pnpm\s+|yarn\s+|bunx\s+)?(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|unittest|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|make\s+(?:test|tests|check)|gradle\w*\s+test|mvnw?\s+.*\btest\b|rspec|phpunit|mix\s+test|swift\s+test|isitdone)\b/;
export const CHECK_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|lint|check|build|verify|validate)\b|\b(?:npx\s+)?(?:tsc|eslint|biome|ruff|mypy|pyright|flake8|go\s+(?:vet|build)|cargo\s+(?:check|clippy|build)|dotnet\s+build)\b/;
export const SHELL_EDIT = /\bsed\s+-i\b|\btee\b|\bcat\s*>|(?:^|[^>2&])>\s*[^&\s]|\bmv\s|\bcp\s|\bpatch\b|\bapply_patch\b|\bgit\s+(?:checkout|restore|stash|revert|cherry-pick|merge|rebase|apply)\b/;

export function classifyCommand(cmd: string): 'test' | 'check' | 'edit' | null {
  if (TEST_CMD.test(cmd)) return 'test';
  if (CHECK_CMD.test(cmd)) return 'check';
  if (SHELL_EDIT.test(cmd)) return 'edit';
  return null;
}

export interface TurnStats {
  editTurns: number;
}

export class TurnTracker {
  private edits = 0;
  private lastEditAt = 0;
  private testRuns = 0;
  private checkRuns = 0;
  private lastTest: { at: number; ok: boolean } | null = null;
  private lastText = '';
  private lastTextAt = 0;
  private pending = new Map<string, { kind: 'test' | 'check'; at: number }>();

  constructor(
    private readonly meta: { project: () => string; session: string; agent: ClaimRecord['agent']; sinceMs: number },
    private readonly out: ClaimRecord[],
    private readonly stats: TurnStats,
  ) {}

  edit(at: number): void {
    this.edits++;
    this.lastEditAt = at;
  }

  /** A command was issued; its outcome arrives later via resolve(). */
  command(id: string, cmd: string, at: number): void {
    const kind = classifyCommand(cmd);
    if (kind === 'test' || kind === 'check') this.pending.set(id, { kind, at });
    else if (kind === 'edit') this.edit(at);
  }

  /** A command finished. `ok` is null when the exit status is unknown (treated as success). */
  resolve(id: string, ok: boolean | null, at: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.record(p.kind, ok, at || p.at);
  }

  /** A command with a known outcome, all at once (paginated Codex items). */
  ran(cmd: string, ok: boolean | null, at: number): void {
    const kind = classifyCommand(cmd);
    if (kind === 'test' || kind === 'check') this.record(kind, ok, at);
    else if (kind === 'edit') this.edit(at);
  }

  private record(kind: 'test' | 'check', ok: boolean | null, at: number): void {
    if (kind === 'test') {
      this.testRuns++;
      this.lastTest = { at, ok: ok !== false };
    } else {
      this.checkRuns++;
    }
  }

  text(t: string, at: number): void {
    if (t.trim() === '') return;
    this.lastText = t;
    this.lastTextAt = at;
  }

  /** Close the turn: classify its final claim (if any) and reset. */
  finalize(): void {
    if (this.edits > 0) this.stats.editTurns++;
    if (this.edits > 0 || this.testRuns > 0) {
      const claim = findClaim(this.lastText);
      if (claim && this.edits > 0 && !(this.meta.sinceMs && this.lastTextAt < this.meta.sinceMs)) {
        let verdict: Verdict;
        if (this.testRuns === 0 || !this.lastTest) verdict = 'NEVER_RAN';
        else if (!this.lastTest.ok) verdict = 'FAILED';
        else if (this.lastEditAt > this.lastTest.at) verdict = 'STALE';
        else verdict = 'VERIFIED';
        this.out.push({
          project: this.meta.project(),
          session: this.meta.session,
          at: new Date(this.lastTextAt || 0).toISOString(),
          verdict,
          claim: claim.sentence,
          pattern: claim.pattern,
          edits: this.edits,
          testRuns: this.testRuns,
          checkRuns: this.checkRuns,
          agent: this.meta.agent,
        });
      }
    }
    this.edits = 0;
    this.lastEditAt = 0;
    this.testRuns = 0;
    this.checkRuns = 0;
    this.lastTest = null;
    this.lastText = '';
    this.lastTextAt = 0;
    this.pending.clear();
  }
}

export function ts(v: unknown): number {
  const n = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}
