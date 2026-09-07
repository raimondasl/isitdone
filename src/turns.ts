/**
 * Turn bookkeeping shared by the transcript parsers (Claude Code, Codex, Gemini CLI, Qwen Code, Cursor): per user turn,
 * did the agent edit files, run tests, and what did it say last. `finalize()` classifies the turn's completion claim.
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
  agent: 'claude-code' | 'codex' | 'gemini' | 'qwen' | 'cursor';
  /** The transcript carries no exit codes (Cursor agent-transcripts): every test run was assumed to have passed. */
  lossy?: boolean;
}

export const TEST_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:\w+|jest|vitest|e2e)\b|\b(?:npx\s+|pnpm\s+|yarn\s+|bunx\s+)?(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|unittest|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|make\s+(?:test|tests|check)|gradle\w*\s+test|mvnw?\s+.*\btest\b|rspec|phpunit|mix\s+test|swift\s+test|isitdone(?!\s+(?:doctor|init|uninstall|history|hook|update|receipt|detect)\b))\b/;
export const CHECK_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|lint|check|build|verify|validate)\b|\b(?:npx\s+)?(?:tsc|eslint|biome|ruff|mypy|pyright|flake8|go\s+(?:vet|build)|cargo\s+(?:check|clippy|build)|dotnet\s+build)\b/;
export const SHELL_EDIT = /\bsed\s+-i\b|\btee\b|\bcat\s*>|(?:^|[^>2&])>\s*(?!\/dev\/null\b)[^&\s]|\bmv\s|\bcp\s|(?:^|[;&|(]\s*)patch\s|\bapply_patch\b|\bgit\s+(?:checkout|restore|stash|revert|cherry-pick|merge|rebase|apply)\b/;

/** Quoted strings blanked, so a ">" inside a grep pattern is not a redirection. */
function unquoted(cmd: string): string {
  return cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`/g, '""');
}

export function classifyCommand(cmd: string): 'test' | 'check' | 'edit' | null {
  if (TEST_CMD.test(cmd)) return 'test';
  if (CHECK_CMD.test(cmd)) return 'check';
  if (SHELL_EDIT.test(unquoted(cmd))) return 'edit';
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
  /** Old id -> the id a pending command now lives under (Codex: call id -> session id -> write_stdin call id). */
  private aliases = new Map<string, string>();
  /** Anything happened since the last finalize(): only such turns are closed and remembered for rollback(). */
  private active = false;
  /** Closed turns of this session, oldest first, so a host's "undo the last N turns" can retract their claims. */
  private readonly turns: Array<{ claim: ClaimRecord | null; edited: boolean }> = [];

  constructor(
    private readonly meta: { project: () => string; session: string; agent: ClaimRecord['agent']; sinceMs: number; lossy?: boolean },
    private readonly out: ClaimRecord[],
    private readonly stats: TurnStats,
  ) {}

  /** A user prompt opened this turn (a prompted turn with no other activity still counts for rollback()). */
  prompt(): void {
    this.active = true;
  }

  edit(at: number): void {
    this.active = true;
    this.edits++;
    this.lastEditAt = at;
  }

  /** A command was issued; its outcome arrives later via resolve(). */
  command(id: string, cmd: string, at: number): void {
    this.active = true;
    const kind = classifyCommand(cmd);
    if (kind === 'test' || kind === 'check') this.pending.set(id, { kind, at });
    else if (kind === 'edit') this.edit(at);
  }

  private key(id: string): string {
    let k = id;
    for (let i = 0; i < 16 && this.aliases.has(k); i++) k = this.aliases.get(k) as string;
    return k;
  }

  /** A command finished. `ok` is null when the exit status is unknown (treated as success). */
  resolve(id: string, ok: boolean | null, at: number): void {
    const k = this.key(id);
    const p = this.pending.get(k);
    if (!p) return;
    this.pending.delete(k);
    this.record(p.kind, ok, at || p.at);
  }

  /** The command is still running; its outcome will arrive under `newId`. Nothing is recorded yet. */
  rekey(oldId: string, newId: string): void {
    const k = this.key(oldId);
    const p = this.pending.get(k);
    if (!p) return;
    this.pending.delete(k);
    this.aliases.delete(newId);
    this.pending.set(newId, p);
    this.aliases.set(oldId, newId);
    if (k !== oldId) this.aliases.set(k, newId);
  }

  isPending(id: string): boolean {
    return this.pending.has(this.key(id));
  }

  /** The command never ran (declined, aborted): drop it without recording a result. */
  forget(id: string): void {
    this.pending.delete(this.key(id));
  }

  /** A command with a known outcome, all at once (paginated Codex items, Gemini tool calls, Cursor bubbles). */
  ran(cmd: string, ok: boolean | null, at: number): void {
    this.active = true;
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
    this.active = true;
    this.lastText = t;
    this.lastTextAt = at;
  }

  /**
   * The host undid the last `n` turns (Codex thread_rolled_back): the open turn is closed first and counts as one of
   * them; their claims are retracted and editTurns adjusted.
   */
  rollback(n: number): void {
    this.finalize();
    for (let i = 0; i < n; i++) {
      const t = this.turns.pop();
      if (!t) break;
      if (t.edited) this.stats.editTurns--;
      if (t.claim) {
        const k = this.out.lastIndexOf(t.claim);
        if (k >= 0) this.out.splice(k, 1);
      }
    }
  }

  /** Close the turn: classify its final claim (if any) and reset. A no-op when nothing happened since the last close. */
  finalize(): void {
    if (!this.active) return;
    let pushed: ClaimRecord | null = null;
    if (this.edits > 0) this.stats.editTurns++;
    if (this.edits > 0 || this.testRuns > 0) {
      const claim = findClaim(this.lastText);
      if (claim && this.edits > 0 && !(this.meta.sinceMs && this.lastTextAt < this.meta.sinceMs)) {
        let verdict: Verdict;
        if (this.testRuns === 0 || !this.lastTest) verdict = 'NEVER_RAN';
        else if (!this.lastTest.ok) verdict = 'FAILED';
        else if (this.lastEditAt > this.lastTest.at) verdict = 'STALE';
        else verdict = 'VERIFIED';
        pushed = {
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
        };
        if (this.meta.lossy) pushed.lossy = true;
        this.out.push(pushed);
      }
    }
    this.turns.push({ claim: pushed, edited: this.edits > 0 });
    this.active = false;
    this.edits = 0;
    this.lastEditAt = 0;
    this.testRuns = 0;
    this.checkRuns = 0;
    this.lastTest = null;
    this.lastText = '';
    this.lastTextAt = 0;
    this.pending.clear();
    this.aliases.clear();
  }
}

export function ts(v: unknown): number {
  const n = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}
