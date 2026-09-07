import type { IsitdoneConfig } from './config.js';
import { detectChecks, type Check, type Detection } from './detect.js';
import { gitInfo, type GitInfo } from './git.js';
import { configHash, evaluateReceipt, writeReceipt, type Receipt, type ReceiptEvaluation } from './receipt.js';
import { runCheck, type RunResult } from './run.js';

export type ResolvedProfile = 'lite' | 'full';

export interface VerifyOptions {
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
}

export const DEFAULT_TIMEOUT_S = 120;
export const DEFAULT_LITE_TIMEOUT_S = 60;

export function timeoutFor(check: Check, config: IsitdoneConfig): number {
  if (check.timeout !== undefined) return check.timeout * 1000;
  if (check.kind === 'lite') return (config.liteTimeout ?? DEFAULT_LITE_TIMEOUT_S) * 1000;
  return (config.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
}

/** Does a valid receipt already prove this tree at the requested profile? */
export function receiptSatisfies(evaluation: ReceiptEvaluation, profile: ResolvedProfile): boolean {
  if (evaluation.state !== 'PASS' || !evaluation.receipt) return false;
  if (profile === 'full') return evaluation.receipt.profile === 'full';
  return true;
}

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const started = Date.now();
  const git = gitInfo(opts.root);
  const root = git.root;
  const detection = detectChecks(root, opts.config);
  const ch = configHash(root);
  const before = evaluateReceipt(root, git, ch);
  const claim = opts.claim ?? null;

  const base: Omit<VerifyResult, 'ok' | 'ran' | 'skipped' | 'receipt' | 'cached' | 'durationMs'> = {
    git,
    detection,
    profile: opts.profile,
    before,
    claim,
  };

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

  const ran: RunResult[] = [];
  let liteFailed = false;
  for (const check of wanted) {
    if (check.kind === 'full' && liteFailed && !opts.all) {
      skipped.push({ check, reason: 'skipped because a lite check failed (use --all to run anyway)' });
      continue;
    }
    opts.onCheckStart?.(check);
    const result = await runCheck(check, {
      cwd: check.cwd ? `${root}/${check.cwd}` : root,
      timeoutMs: timeoutFor(check, opts.config),
      onOutput: opts.onOutput ? (chunk) => opts.onOutput?.(check, chunk) : undefined,
    });
    ran.push(result);
    opts.onCheckDone?.(result);
    if (result.status !== 'PASS' && check.kind === 'lite') liteFailed = true;
  }

  const ok = ran.every((r) => r.status === 'PASS');
  const fullRan = detection.checks.filter((c) => c.kind === 'full').every((c) => ran.some((r) => r.id === c.id));
  const receipt = opts.dryRun
    ? null
    : writeReceipt(root, {
        status: ok ? 'PASS' : 'FAIL',
        profile: ok && fullRan ? 'full' : 'lite',
        head: git.head,
        branch: git.branch,
        tree: git.tree,
        dirtyFiles: git.dirtyFiles,
        configHash: ch,
        checks: ran,
        claim,
        host: opts.host ?? null,
      });

  return { ...base, ok, ran, skipped, receipt, cached: false, durationMs: Date.now() - started };
}
