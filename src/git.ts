import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface GitInfo {
  isRepo: boolean;
  /** Absolute git top-level directory (or the project root when not a git repo). */
  root: string;
  head: string | null;
  headShort: string | null;
  branch: string | null;
  /** Hash of the working tree content (tracked changes and untracked files), "nogit", or "unknown". */
  tree: string;
  /** Why the tree is "unknown", when it is. */
  treeError: string | null;
  /** Number of modified/added/deleted/untracked paths. */
  dirtyFiles: number;
  /** Paths (up to 20) that are dirty, for display. */
  dirtyPaths: string[];
}

export const RECEIPT_DIR = '.isitdone';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string): GitResult {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    input,
  });
  if (r.error) return { ok: false, stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, stdout: (r.stdout ?? '').replace(/\r?\n$/, ''), stderr: (r.stderr ?? '').trim() };
}

function out(args: string[], cwd: string): string | null {
  const r = git(args, cwd);
  return r.ok ? r.stdout : null;
}

export function gitTopLevel(cwd: string): string | null {
  const top = out(['rev-parse', '--show-toplevel'], cwd);
  if (!top) return null;
  // Windows may report 8.3 short names (C:/Users/RUNNER~1/...); the native realpath gives the canonical long form
  // so paths coming from the host (long form) compare equal.
  try {
    return realpathSync.native(top);
  } catch {
    return resolve(top);
  }
}

/**
 * Hash the working tree (tracked changes AND untracked non-ignored files) without touching the real index
 * and without writing any blob into .git/objects (secrets in untracked files never enter the object store).
 * Uses a temporary index seeded from the real one so unchanged files are not re-hashed.
 */
export function workingTreeHash(top: string): { tree: string | null; error: string | null } {
  const tmp = join(tmpdir(), `isitdone-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: tmp };
  try {
    const rel = out(['rev-parse', '--git-path', 'index'], top);
    if (rel) {
      const p = isAbsolute(rel) ? rel : join(top, rel);
      if (existsSync(p)) copyFileSync(p, tmp);
    }
    const exclude = `:(exclude)${RECEIPT_DIR}`;
    // Untracked (not ignored) files, plus tracked files that were modified or deleted.
    const others = git(['ls-files', '-z', '--others', '--exclude-standard', '--', '.', exclude], top, env);
    if (!others.ok) return { tree: null, error: `git ls-files failed: ${others.stderr}` };
    const changed = git(['ls-files', '-z', '--modified', '--deleted', '--', '.', exclude], top, env);
    if (!changed.ok) return { tree: null, error: `git ls-files failed: ${changed.stderr}` };
    // Submodules (gitlinks in the index) and embedded repositories (untracked "dir/" entries) are hashed recursively.
    const stage = git(['ls-files', '-z', '--stage'], top, env);
    const gitlinks = new Set(
      (stage.ok ? stage.stdout : '')
        .split('\0')
        .filter((l) => l.startsWith('160000 '))
        .map((l) => l.split('\t')[1] ?? '')
        .filter(Boolean),
    );
    const nested: string[] = [];
    const paths = new Set<string>();
    for (const p of [...others.stdout.split('\0'), ...changed.stdout.split('\0')]) {
      if (p === '') continue;
      if (p.endsWith('/')) nested.push(p.slice(0, -1)); // an embedded repo shows up as "dir/"
      else if (!gitlinks.has(p)) paths.add(p);
    }
    if (paths.size > 0) {
      // --info-only: record object ids in the temp index without creating objects.
      const upd = git(['update-index', '--info-only', '--add', '--remove', '-z', '--stdin'], top, env, [...paths].join('\0') + '\0');
      if (!upd.ok) return { tree: null, error: `git update-index failed: ${upd.stderr}` };
    }
    const wt = git(['write-tree', '--missing-ok'], top, env);
    if (!wt.ok) return { tree: null, error: `git write-tree failed: ${wt.stderr}` };
    const inner = [...gitlinks, ...nested].sort();
    if (inner.length === 0) return { tree: wt.stdout.trim(), error: null };
    const h = createHash('sha1').update(wt.stdout.trim());
    for (const path of inner) {
      const sub = workingTreeHash(join(top, path));
      if (sub.error) return { tree: null, error: `submodule ${path}: ${sub.error}` };
      h.update('\0').update(path).update('\0').update(sub.tree ?? 'unknown');
    }
    return { tree: h.digest('hex'), error: null };
  } catch (err) {
    return { tree: null, error: (err as Error).message };
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
  const top = gitTopLevel(cwd);
  if (!top) {
    return { isRepo: false, root: cwd, head: null, headShort: null, branch: null, tree: 'nogit', treeError: null, dirtyFiles: 0, dirtyPaths: [] };
  }
  const head = out(['rev-parse', 'HEAD'], top);
  const branch = out(['rev-parse', '--abbrev-ref', 'HEAD'], top);
  const status = git(['status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${RECEIPT_DIR}`], top);
  const dirtyPaths = (status.ok ? status.stdout : '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.slice(3).trim());
  const { tree, error } = workingTreeHash(top);
  return {
    isRepo: true,
    root: top,
    head,
    headShort: head ? head.slice(0, 7) : null,
    branch: branch === 'HEAD' ? null : branch,
    tree: tree ?? 'unknown',
    treeError: error,
    dirtyFiles: dirtyPaths.length,
    dirtyPaths: dirtyPaths.slice(0, 20),
  };
}

const PROJECT_MARKERS = ['.isitdone.json', 'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pytest.ini', 'go.mod', 'Cargo.toml', 'Makefile', 'makefile', 'build.gradle', 'build.gradle.kts', 'pom.xml'];

function hasProjectMarker(dir: string): boolean {
  if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return true;
  try {
    return readdirSync(dir).some((e) => /\.(sln|slnx|csproj|fsproj)$/i.test(e));
  } catch {
    return false;
  }
}

/**
 * The project root: the nearest directory at or above `cwd` (never above the git top-level) that looks like a
 * project. Falls back to the git top-level, or to `cwd` outside git. This is where config, checks and receipts live.
 */
export function findRoot(cwd: string): string {
  let start = resolve(cwd);
  try {
    start = realpathSync.native(start);
  } catch {
    // keep the resolved path
  }
  const top = gitTopLevel(start);
  let dir = start;
  for (;;) {
    if (hasProjectMarker(dir)) return dir;
    if (top && resolve(dir) === top) return top;
    const parent = dirname(dir);
    if (parent === dir) return top ?? start;
    if (top && !parent.startsWith(top)) return top;
    dir = parent;
  }
}
