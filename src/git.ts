import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface GitInfo {
  isRepo: boolean;
  /** Absolute repo root (or the cwd when not a git repo). */
  root: string;
  head: string | null;
  headShort: string | null;
  branch: string | null;
  /** Hash of the working tree content (git write-tree over a temporary index), "nogit", or "unknown". */
  tree: string;
  /** Number of modified/added/deleted/untracked paths. */
  dirtyFiles: number;
  /** Paths (up to 20) that are dirty, for display. */
  dirtyPaths: string[];
}

export const RECEIPT_DIR = '.isitdone';

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

function tryGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    return git(args, cwd, env);
  } catch {
    return null;
  }
}

/**
 * Hash the working tree (tracked changes AND untracked non-ignored files) without touching the real index.
 * Uses a temporary index seeded from the real one so unchanged files are not re-hashed.
 */
export function workingTreeHash(root: string): string | null {
  const realIndex = tryGit(['rev-parse', '--git-path', 'index'], root);
  const tmp = join(tmpdir(), `isitdone-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    if (realIndex) {
      const p = isAbsolute(realIndex) ? realIndex : join(root, realIndex);
      if (existsSync(p)) copyFileSync(p, tmp);
    }
    const env = { GIT_INDEX_FILE: tmp };
    // Stage everything (adds, modifications, deletions) into the temp index, excluding our own state dir.
    git(['add', '-A', '--', '.', `:(exclude)${RECEIPT_DIR}`], root, env);
    return git(['write-tree'], root, env);
  } catch {
    return null;
  } finally {
    try {
      rmSync(tmp, { force: true });
      rmSync(tmp + '.lock', { force: true });
    } catch {
      // ignore
    }
  }
}

export function gitInfo(cwd: string): GitInfo {
  const root = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!root) {
    return { isRepo: false, root: cwd, head: null, headShort: null, branch: null, tree: 'nogit', dirtyFiles: 0, dirtyPaths: [] };
  }
  const head = tryGit(['rev-parse', 'HEAD'], root);
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const status = tryGit(['status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${RECEIPT_DIR}`], root) ?? '';
  const dirtyPaths = status
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.slice(3).trim());
  const tree = workingTreeHash(root) ?? 'unknown';
  return {
    isRepo: true,
    root,
    head,
    headShort: head ? head.slice(0, 7) : null,
    branch: branch === 'HEAD' ? null : branch,
    tree,
    dirtyFiles: dirtyPaths.length,
    dirtyPaths: dirtyPaths.slice(0, 20),
  };
}

export function findRoot(cwd: string): string {
  return tryGit(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
}
