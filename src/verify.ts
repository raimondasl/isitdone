import { join } from 'node:path';
import type { IsitdoneConfig } from './config.js';
import { detectChecks, type Check, type Detection } from './detect.js';
import { collectDiff, readAtBase, readNow } from './diff.js';
import { existingPathsChanged, gitInfo, type GitInfo } from './git.js';
import { scanIntegrity, type IntegrityReport } from './integrity.js';
import { configHash, evaluateReceipt, writeReceipt, type Receipt, type ReceiptEvaluation } from './receipt.js';
import { childEnv, runCheck, type RunResult } from './run.js';
import { acquireRunLock, editsSince } from './sessions.js';

export type ResolvedProfile = 'lite' | 'full';

export interface VerifyOptions {
  /** Project root (where config, checks and receipts live). */
  root: string;
  config: IsitdoneConfig;
  profile: ResolvedProfile;
  /** The quoted completion claim that triggered this run, if any. */
  claim?: string | null;
  /** Which agent host invoked us, if any (claude-code, codex, cursor, gemini-cli). */
  host?: string | null;
  /** Run full checks even if a lite check failed. Default false (fail fast at the lite/full boundary). */
  all?: boolean;
  /** Skip the run entirely when a valid PASS receipt exists for this exact tree. Default true. */
  useCache?: boolean;
  /** Run the checks but do not write a receipt (doctor mode). */
  dryRun?: boolean;
  /** Ref to diff against for the integrity scan. Default HEAD (the working tree's uncommitted changes). */
  base?: string;
  /** CI mode for the integrity scan: new suppressions are findings. */
  ci?: boolean;
  /**
   * Serialise with other check runs in this project: how long to wait for a run in progress (ms, or a function of the
   * checks about to run) before running alongside it. The lock is taken after the cache check, so a cached PASS never
   * waits. Omitted or 0: no lock.
   */
  lockWaitMs?: number | ((wanted: Check[]) => number);
  /** Called once when the run has to wait for another one. */
  onLockWait?: () => void;
  /** Abort the run: the running check is killed, the remaining ones are skipped, and no receipt is written. */
  signal?: AbortSignal;
  onCheckStart?: (check: Check) => void;
  onCheckDone?: (result: RunResult) => void;
  onOutput?: (check: Check, chunk: string) => void;
}

export interface SkippedCheck {
  check: Check;
  reason: string;
}

export interface VerifyResult {
  ok: boolean;
  git: GitInfo;
  detection: Detection;
  profile: ResolvedProfile;
  ran: RunResult[];
  skipped: SkippedCheck[];
  receipt: Receipt | null;
  /** True when a valid PASS receipt for this exact tree made the run unnecessary. */
  cached: boolean;
  /** Receipt state before this run. */
  before: ReceiptEvaluation;
  durationMs: number;
  claim: string | null;
  /** Non-fatal problems (e.g. the receipt could not be written). */
  warnings: string[];
  /** Test-integrity scan of the change set (null when disabled or not a git repo). */
  integrity: IntegrityReport | null;
  /** Integrity mode that applied. */
  integrityMode: 'warn' | 'strict' | 'off';
  /** The per-project run lock, when one was asked for and the run got as far as needing it. */
  lock?: { waitedMs: number; held: boolean; tookOver: boolean };
}

/** Scan the change set for weakened tests. Never throws; a scan failure becomes a warning. */
export function runIntegrity(git: GitInfo, opts: { base?: string; ci?: boolean }, warnings: string[]): IntegrityReport | null {
  if (!git.isRepo) return null;
  const base = opts.base ?? 'HEAD';
  const diff = collectDiff(git.root, base);
  if (diff.error) {
    warnings.push(`integrity scan skipped: ${diff.error}`);
    return null;
  }
  try {
    return scanIntegrity(diff.files, {
      readBefore: (p) => readAtBase(git.root, p, base),
      readAfter: (p) => readNow(git.root, p),
      ci: opts.ci ?? false,
    });
  } catch (err) {
    warnings.push(`integrity scan failed: ${(err as Error).message}`);
    return null;
  }
}

export const DEFAULT_TIMEOUT_S = 120;
export const DEFAULT_LITE_TIMEOUT_S = 60;

export function timeoutFor(check: Check, config: IsitdoneConfig): number {
  if (check.timeout !== undefined) return check.timeout * 1000;
  if (check.kind === 'lite') return (config.liteTimeout ?? DEFAULT_LITE_TIMEOUT_S) * 1000;
  return (config.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
}

/** Worst-case seconds a full run can take (for sizing the host's hook timeout). */
export function budgetSeconds(checks: Check[], config: IsitdoneConfig): number {
  return checks.reduce((sum, c) => sum + timeoutFor(c, config) / 1000, 0);
}

/** Does a valid receipt already prove this tree at the requested profile? */
export function receiptSatisfies(evaluation: ReceiptEvaluation, profile: ResolvedProfile): boolean {
  if (evaluation.state !== 'PASS' || !evaluation.receipt) return false;
  if (profile === 'full') return evaluation.receipt.profile === 'full';
  return true;
}

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const started = Date.now();
  const root = opts.root;
  let git = gitInfo(root);
  const detection = detectChecks(root, opts.config);
  const ch = configHash(root);
  const before = evaluateReceipt(root, git, ch);
  const claim = opts.claim ?? null;
  const warnings: string[] = [];
  if (git.treeError) warnings.push(`working tree could not be hashed (${git.treeError}); receipts cannot be cached`);
  const integrityMode = opts.config.integrity ?? 'warn';
  const integrity = integrityMode === 'off' ? null : runIntegrity(git, { base: opts.base, ci: opts.ci }, warnings);

  let base = { git, detection, profile: opts.profile, before, claim, warnings, integrity, integrityMode };

  if ((opts.useCache ?? true) && receiptSatisfies(before, opts.profile)) {
    return { ...base, ok: true, ran: [], skipped: [], receipt: before.receipt, cached: true, durationMs: Date.now() - started };
  }

  const wanted = opts.profile === 'full' ? detection.checks : detection.checks.filter((c) => c.kind === 'lite');
  const skipped: SkippedCheck[] = detection.checks
    .filter((c) => !wanted.includes(c))
    .map((check) => ({ check, reason: 'full checks run only when the agent claims completion (claim-gated profile)' }));

  if (wanted.length === 0) {
    // Nothing to verify; do not write a receipt that would vacuously say PASS.
    return { ...base, ok: true, ran: [], skipped, receipt: null, cached: false, durationMs: Date.now() - started };
  }

  const waitMs = typeof opts.lockWaitMs === 'function' ? opts.lockWaitMs(wanted) : (opts.lockWaitMs ?? 0);
  const lock = waitMs > 0 ? await acquireRunLock(root, waitMs, opts.onLockWait) : null;
  const lockInfo = lock ? { waitedMs: lock.waitedMs, held: lock.held, tookOver: lock.tookOver } : undefined;
  try {
    if (lock && lock.waitedMs > 1000) {
      // Time passed: the tree may have moved on, and the run we waited for may have proved this exact tree. Its PASS
      // counts only if it STARTED on this tree: a receipt is bound to the tree after the run, and our own last edits
      // may have landed while that run was already reading the files.
      git = gitInfo(root);
      const again = evaluateReceipt(root, git, ch);
      base = { ...base, git, before: again };
      if ((opts.useCache ?? true) && receiptSatisfies(again, opts.profile) && again.receipt?.treeBefore === git.tree) {
        return { ...base, ok: true, ran: [], skipped: [], receipt: again.receipt, cached: true, durationMs: Date.now() - started, lock: lockInfo };
      }
    }

    const runStarted = Date.now();
    const env = childEnv(process.env, detection.env);
    const ran: RunResult[] = [];
    let liteFailed = false;
    for (const check of wanted) {
      if (opts.signal?.aborted) {
        skipped.push({ check, reason: 'cancelled' });
        continue;
      }
      if (check.kind === 'full' && liteFailed && !opts.all) {
        skipped.push({ check, reason: 'skipped because a lite check failed (use --all to run anyway)' });
        continue;
      }
      opts.onCheckStart?.(check);
      const result = await runCheck(check, {
        cwd: check.cwd ? join(root, check.cwd) : root,
        timeoutMs: timeoutFor(check, opts.config),
        env,
        onOutput: opts.onOutput ? (chunk) => opts.onOutput?.(check, chunk) : undefined,
        signal: opts.signal,
      });
      ran.push(result);
      opts.onCheckDone?.(result);
      if (result.status !== 'PASS' && check.kind === 'lite') liteFailed = true;
    }

    // A cancelled run proves nothing either way: it is not ok, and it must not leave a FAIL receipt behind.
    const cancelled = opts.signal?.aborted ?? false;
    if (cancelled) warnings.push('verification was cancelled; no receipt was written');
    const ok = !cancelled && ran.every((r) => r.status === 'PASS');
    const fullRan = detection.checks.filter((c) => c.kind === 'full').every((c) => ran.some((r) => r.id === c.id));

    let receipt: Receipt | null = null;
    if (!opts.dryRun && !cancelled) {
      // Checks may write files (coverage, build output). Bind the receipt to the tree as it is now,
      // and remember the pre-run tree so either matches on the next stop.
      let after = git.isRepo ? gitInfo(root) : git;
      // ...unless files were edited while the checks ran (a session recorded an edit, or a path that already existed
      // was modified or deleted, which checks rarely do): then the difference is not just the checks' own output,
      // nothing proves the tree as it is now, and the receipt stands for the tree the run started on.
      if (after.tree !== git.tree && (editsSince([git.root, root], runStarted) || existingPathsChanged(git.root, git.tree, after.tree))) {
        warnings.push('files changed while the checks ran; the receipt covers the tree the run started on, not the current one');
        after = git;
      }
      try {
        receipt = writeReceipt(root, {
          status: ok ? 'PASS' : 'FAIL',
          profile: ok && fullRan ? 'full' : 'lite',
          head: after.head,
          branch: after.branch,
          tree: after.tree,
          treeBefore: git.tree,
          startedAt: new Date(runStarted).toISOString(),
          dirtyFiles: after.dirtyFiles,
          configHash: ch,
          checks: ran,
          claim,
          host: opts.host ?? null,
          integrity: integrity ? { findings: integrity.findings, summary: integrity.summary, base: opts.base ?? 'HEAD' } : null,
        });
      } catch (err) {
        warnings.push(`receipt could not be written: ${(err as Error).message}`);
      }
    }

    return { ...base, ok, ran, skipped, receipt, cached: false, durationMs: Date.now() - started, lock: lockInfo };
  } finally {
    lock?.release();
  }
}
