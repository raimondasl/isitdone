import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from './detect.js';
import { readTextFile, writeFileAtomic } from './fsutil.js';
import { RECEIPT_DIR } from './git.js';
import { ensureStateDir, signText } from './receipt.js';
import type { RunResult } from './run.js';

/**
 * The last PASS of each check that declares "ignore" patterns, bound to the hash of the files that check reads (every
 * file of the working tree except the ignored ones, as git sees them). While those files are the same, the check would
 * see what it saw then, so its pass is reused instead of running it again. Signed like the receipt.
 */
export interface PassRecord {
  cmd: string;
  cwd: string | null;
  ignore: string[];
  configHash: string;
  /** Hash of the inputs the passing run started on, recorded only when they were the same when it ended. */
  inputs: string;
  /** When the run that passed started. */
  at: string;
  /** Working-tree hash the run started on. */
  tree: string;
  durationMs: number;
  summary?: string;
}

interface PassFile {
  version: 1;
  checks: Record<string, PassRecord>;
  hmac?: string;
}

export const PASSES_FILE = 'passes.json';

function canonical(f: PassFile): string {
  return JSON.stringify({ version: f.version, checks: f.checks });
}

/** Recorded passes; empty when there are none or the file is unreadable or was not written by isitdone. */
export function readPasses(root: string): Record<string, PassRecord> {
  const file = join(root, RECEIPT_DIR, PASSES_FILE);
  if (!existsSync(file)) return {};
  try {
    const f = JSON.parse(readTextFile(file)) as PassFile;
    if (f.version !== 1 || typeof f.checks !== 'object' || f.checks === null || !f.hmac) return {};
    return f.hmac === signText(root, canonical(f)) ? f.checks : {};
  } catch {
    return {};
  }
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** The recorded pass that proves this check for these inputs, or null. */
export function reusablePass(rec: PassRecord | undefined, check: Check, configHash: string, inputs: string | null | undefined): PassRecord | null {
  if (!rec || !inputs || !check.ignore || check.ignore.length === 0) return null;
  if (rec.cmd !== check.cmd || rec.cwd !== (check.cwd ?? null) || rec.configHash !== configHash || !sameList(rec.ignore, check.ignore)) return null;
  return rec.inputs === inputs ? rec : null;
}

/** A check result standing for a reused pass. */
export function reusedResult(check: Check, rec: PassRecord, timeoutMs: number): RunResult {
  return {
    id: check.id,
    cmd: check.cmd,
    status: 'PASS',
    exitCode: 0,
    durationMs: 0,
    timeoutMs,
    tail: [],
    lines: 0,
    ...(rec.summary ? { summary: rec.summary } : {}),
    reused: { at: rec.at, tree: rec.tree, durationMs: rec.durationMs },
  };
}

/** Record fresh passes and forget the passes of checks that just failed. Read-modify-write; a lost race only costs a run. */
export function updatePasses(root: string, set: Record<string, PassRecord>, drop: string[]): void {
  if (Object.keys(set).length === 0 && drop.length === 0) return;
  const checks = { ...readPasses(root) };
  let changed = false;
  for (const id of drop) {
    if (id in checks) {
      delete checks[id];
      changed = true;
    }
  }
  for (const [id, rec] of Object.entries(set)) {
    checks[id] = rec;
    changed = true;
  }
  if (!changed) return;
  const f: PassFile = { version: 1, checks };
  f.hmac = signText(root, canonical(f));
  writeFileAtomic(join(ensureStateDir(root), PASSES_FILE), JSON.stringify(f, null, 2) + '\n');
}
