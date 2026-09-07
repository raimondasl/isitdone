import { createHmac, randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTextFile, writeFileAtomic } from './fsutil.js';
import { RECEIPT_DIR, type GitInfo } from './git.js';
import type { RunResult } from './run.js';
import { VERSION } from './version.js';

export type ReceiptStatus = 'PASS' | 'FAIL';
export type ReceiptState = 'PASS' | 'FAIL' | 'STALE' | 'NONE';

export interface Receipt {
  version: 1;
  tool: string;
  createdAt: string;
  status: ReceiptStatus;
  /** "full" if every full check ran, "lite" if only lite checks ran. */
  profile: 'full' | 'lite';
  head: string | null;
  branch: string | null;
  /** Working-tree hash after the checks ran. */
  tree: string;
  /** Working-tree hash before the checks ran (checks may write files). */
  treeBefore?: string;
  dirtyFiles: number;
  configHash: string;
  checks: RunResult[];
  claim: string | null;
  host: string | null;
  hmac?: string;
}

export interface ReceiptEvaluation {
  state: ReceiptState;
  receipt: Receipt | null;
  /** Why the state is what it is, for humans. */
  reason: string;
}

export const RECEIPT_FILE = 'receipt.json';
const KEY_FILE = 'key';
const KEY_RE = /^[0-9a-f]{64}$/;

function dir(root: string): string {
  return join(root, RECEIPT_DIR);
}

export function ensureStateDir(root: string): string {
  const d = dir(root);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  const gi = join(d, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '*\n');
  return d;
}

function loadKey(root: string): string {
  const d = ensureStateDir(root);
  const f = join(d, KEY_FILE);
  const read = () => {
    try {
      const k = readFileSync(f, 'utf8').trim();
      return KEY_RE.test(k) ? k : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  const key = randomBytes(32).toString('hex');
  try {
    // 'wx' fails if another process created the key first; then use theirs.
    writeFileSync(f, key + '\n', { mode: 0o600, flag: 'wx' });
    return key;
  } catch {
    for (let i = 0; i < 20; i++) {
      const k = read();
      if (k) return k;
      const until = Date.now() + 10;
      while (Date.now() < until) {
        // brief spin: the other writer is between create and write
      }
    }
    writeFileSync(f, key + '\n', { mode: 0o600 });
    return key;
  }
}

function canonical(r: Receipt): string {
  const { hmac: _omit, ...rest } = r;
  return JSON.stringify(rest);
}

function sign(root: string, r: Receipt): string {
  return createHmac('sha256', loadKey(root)).update(canonical(r)).digest('hex');
}

/** Hash the files that define what "the checks" are, so a loosened gate is visible in the receipt. */
export function configHash(root: string): string {
  const h = createHash('sha256');
  const files = ['.isitdone.json', 'package.json', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'Makefile', 'go.mod', 'Cargo.toml'];
  try {
    for (const e of readdirSync(root)) {
      if (/^(jest|vitest|vite|playwright|cypress|karma|mocha|ava)\.config\.[cm]?[jt]s$/.test(e) || /^\.mocharc/.test(e) || e === 'tsconfig.json' || /^eslint\.config\.[cm]?js$/.test(e)) {
        files.push(e);
      }
    }
    const wf = join(root, '.github', 'workflows');
    if (existsSync(wf)) for (const e of readdirSync(wf)) if (/\.ya?ml$/.test(e)) files.push(join('.github', 'workflows', e));
  } catch {
    // ignore
  }
  for (const f of files.sort()) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    let content: string | Buffer = readFileSync(p);
    if (f === 'package.json') {
      // Only the parts that define checks matter, not the version bump.
      try {
        const pkg = JSON.parse(readTextFile(p)) as Record<string, unknown>;
        content = JSON.stringify({ scripts: pkg.scripts, isitdone: pkg.isitdone, packageManager: pkg.packageManager });
      } catch {
        // hash raw
      }
    }
    h.update(f).update('\0').update(content).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export function writeReceipt(root: string, r: Omit<Receipt, 'version' | 'tool' | 'createdAt' | 'hmac'>): Receipt {
  const receipt: Receipt = {
    version: 1,
    tool: `isitdone/${VERSION}`,
    createdAt: new Date().toISOString(),
    ...r,
  };
  receipt.hmac = sign(root, receipt);
  const d = ensureStateDir(root);
  writeFileAtomic(join(d, RECEIPT_FILE), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export function readReceipt(root: string): { receipt: Receipt | null; valid: boolean; reason: string } {
  const f = join(dir(root), RECEIPT_FILE);
  if (!existsSync(f)) return { receipt: null, valid: false, reason: 'no receipt' };
  let receipt: Receipt;
  try {
    receipt = JSON.parse(readTextFile(f)) as Receipt;
  } catch {
    return { receipt: null, valid: false, reason: 'receipt is not valid JSON' };
  }
  if (receipt.version !== 1) return { receipt, valid: false, reason: `unsupported receipt version ${String(receipt.version)}` };
  if (!receipt.hmac || receipt.hmac !== sign(root, receipt)) return { receipt, valid: false, reason: 'receipt signature does not match (edited by hand?)' };
  return { receipt, valid: true, reason: 'ok' };
}

export function evaluateReceipt(root: string, git: GitInfo, currentConfigHash: string): ReceiptEvaluation {
  const { receipt, valid, reason } = readReceipt(root);
  if (!receipt || !valid) return { state: 'NONE', receipt: null, reason };
  if (git.tree === 'nogit') {
    return { state: 'STALE', receipt, reason: 'not a git repository, so the working tree cannot be hashed and the receipt cannot be trusted' };
  }
  if (git.tree === 'unknown') {
    return { state: 'STALE', receipt, reason: `working tree could not be hashed (${git.treeError ?? 'git error'}), so the receipt cannot be trusted` };
  }
  if (receipt.tree !== git.tree && receipt.treeBefore !== git.tree) {
    return { state: 'STALE', receipt, reason: `files changed since the receipt (tree ${receipt.tree.slice(0, 7)} -> ${git.tree.slice(0, 7)})` };
  }
  if (receipt.configHash !== currentConfigHash) {
    return { state: 'STALE', receipt, reason: 'check configuration changed since the receipt' };
  }
  const what = receipt.profile === 'lite' ? 'lite checks (typecheck/lint) passed on this exact tree; tests were not run' : 'all checks passed on this exact tree';
  return { state: receipt.status, receipt, reason: receipt.status === 'PASS' ? what : 'checks failed on this exact tree' };
}
