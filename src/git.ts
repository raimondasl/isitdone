import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ignoreMatcher } from './ignore.js';

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
  /**
   * When asked for (gitInfo's `ignoreSets`): per set of ignore patterns, the hash of every file of the same snapshot
   * except the ignored ones; null when it cannot be told or nothing is left.
   */
  inputs?: Array<string | null>;
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

/** The repository's shared git directory: the same for the main checkout and every linked worktree. */
export function gitCommonDir(cwd: string): string | null {
  const d = out(['rev-parse', '--git-common-dir'], cwd);
  if (!d) return null;
  const abs = resolve(cwd, d);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
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
export function workingTreeHash(top: string, depth = 0, ignored: Array<(path: string) => boolean> = []): { tree: string | null; error: string | null; inputs?: Array<string | null> } {
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
    // "160000 <sha> 0\t<path>": each submodule with the commit the index records for it.
    const gitlinkSha = new Map<string, string>();
    for (const l of (stage.ok ? stage.stdout : '').split('\0')) {
      if (!l.startsWith('160000 ')) continue;
      const path = l.split('\t')[1] ?? '';
      if (path) gitlinkSha.set(path, l.slice(7, 47));
    }
    const gitlinks = new Set(gitlinkSha.keys());
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
    // What each submodule / embedded repository contributes: its own working tree, or the commit the index records.
    const innerHash = new Map<string, string>();
    let tree = wt.stdout.trim();
    if (inner.length > 0) {
      const h = createHash('sha1').update(tree);
      for (const path of inner) {
        const dir = resolve(top, path);
        // Recurse only into a real repository below top. A gitlink whose directory is missing or not initialised (a plain
        // clone, actions/checkout by default) contributes the commit it records; "./" would be top itself, never a child.
        let contribution: string;
        if (depth >= 8 || dir === top || !dir.startsWith(top) || !existsSync(join(dir, '.git'))) {
          contribution = gitlinkSha.get(path) ?? 'missing';
        } else {
          const sub = workingTreeHash(dir, depth + 1);
          if (sub.error) return { tree: null, error: `submodule ${path}: ${sub.error}` };
          contribution = sub.tree ?? 'unknown';
        }
        h.update('\0').update(path).update('\0').update(contribution);
        innerHash.set(path, contribution);
      }
      tree = h.digest('hex');
    }
    if (ignored.length === 0) return { tree, error: null };
    // The inputs of each ignore set, read from the same temporary index the tree came from: one snapshot for both.
    const staged = git(['ls-files', '-s', '-z'], top, env);
    const entries = staged.ok ? staged.stdout.split('\0').filter((e) => e !== '') : null;
    const inputs = ignored.map((isIgnored) => {
      if (!entries) return null;
      const h = createHash('sha256');
      let kept = 0;
      for (const e of entries) {
        // "<mode> <object> <stage>\t<path>"; submodules are taken from innerHash below, with their working trees.
        if (e.startsWith('160000 ')) continue;
        if (isIgnored(e.slice(e.indexOf('\t') + 1))) continue;
        h.update(e).update('\0');
        kept++;
      }
      for (const [path, contribution] of innerHash) {
        if (isIgnored(path) || isIgnored(`${path}/`)) continue;
        h.update('repo\0').update(path).update('\0').update(contribution).update('\0');
        kept++;
      }
      return kept > 0 ? h.digest('hex') : null;
    });
    return { tree, error: null, inputs };
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

/** Every uncommitted path (modified, added, deleted, untracked; both sides of a rename), relative to the top-level. */
export function dirtyPathSet(top: string): Set<string> {
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', `:(exclude)${RECEIPT_DIR}`], top);
  const paths = new Set<string>();
  if (!status.ok) return paths;
  const parts = status.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    paths.add(entry.slice(3));
    // "R  new\0old\0": the original path follows as its own field.
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      const old = parts[++i];
      if (old) paths.add(old);
    }
  }
  return paths;
}

/**
 * Between two working-tree hashes, was a path that already existed modified or deleted? Checks add files (coverage,
 * build output); they rarely rewrite existing ones, so this is the sign of an edit made while the checks ran. False
 * when it cannot be told (a hash that is not a git tree: no repository, submodules folded in).
 */
export function existingPathsChanged(top: string, before: string, after: string): boolean {
  if (!/^[0-9a-f]{40,64}$/.test(before) || !/^[0-9a-f]{40,64}$/.test(after) || before === after) return false;
  const r = git(['diff-tree', '-r', '--name-status', '--no-renames', '-z', before, after], top);
  if (!r.ok) return false;
  const parts = r.stdout.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] === 'M' || parts[i] === 'D') return true;
  return false;
}

/** Every tracked path, relative to the top-level (for telling which file a bare or partial path in check output means). */
export function trackedPaths(top: string): string[] {
  const r = git(['ls-files', '-z'], top);
  return r.ok ? r.stdout.split('\0').filter((p) => p !== '') : [];
}

/** `dir` relative to the top-level as a git path prefix ("" or "sub/dir/"); null when it is not inside it. */
function gitPrefix(top: string, dir: string): string | null {
  let real = dir;
  try {
    real = realpathSync.native(dir);
  } catch {
    // keep as given
  }
  const rel = relative(top, real);
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/') + '/';
}

/**
 * Repository facts for `cwd`. With `ignoreSets` (lists of ignore patterns relative to `cwd`), also the hash of the
 * inputs left by each set, from the same snapshot as the tree hash.
 */
export function gitInfo(cwd: string, ignoreSets: string[][] = []): GitInfo {
  const top = gitTopLevel(cwd);
  if (!top) {
    return { isRepo: false, root: cwd, head: null, headShort: null, branch: null, tree: 'nogit', treeError: null, dirtyFiles: 0, dirtyPaths: [], ...(ignoreSets.length ? { inputs: ignoreSets.map(() => null) } : {}) };
  }
  const head = out(['rev-parse', 'HEAD'], top);
  const branch = out(['rev-parse', '--abbrev-ref', 'HEAD'], top);
  const status = git(['status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${RECEIPT_DIR}`], top);
  const dirtyPaths = (status.ok ? status.stdout : '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.slice(3).trim());
  const prefix = ignoreSets.length ? gitPrefix(top, cwd) : null;
  // A project root that cannot be placed inside the repository ignores nothing: every file stays an input.
  const matchers = ignoreSets.map((patterns) => (prefix === null ? () => false : ignoreMatcher(patterns, prefix)));
  const { tree, error, inputs } = workingTreeHash(top, 0, matchers);
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
    ...(ignoreSets.length ? { inputs: inputs ?? ignoreSets.map(() => null) } : {}),
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
export function findRoot(cwd: string, knownTop?: string | null): string {
  let start = resolve(cwd);
  try {
    start = realpathSync.native(start);
  } catch {
    // keep the resolved path
  }
  const top = knownTop !== undefined ? knownTop : gitTopLevel(start);
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
