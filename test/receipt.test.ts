import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitInfo, workingTreeHash } from '../src/git.js';
import { configHash, evaluateReceipt, readReceipt, writeReceipt } from '../src/receipt.js';
import { tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const passing = (id = 'test') => ({ id, cmd: 'x', status: 'PASS' as const, exitCode: 0, durationMs: 1, timeoutMs: 1000, tail: [], lines: 0 });

describe('gitInfo / workingTreeHash', () => {
  it('describes a clean repo and hashes the tree deterministically', () => {
    repo = tempRepo({ files: { 'a.txt': 'a\n' } });
    const g = gitInfo(repo.root);
    expect(g.isRepo).toBe(true);
    expect(g.branch).toBe('main');
    expect(g.head).toHaveLength(40);
    expect(g.dirtyFiles).toBe(0);
    expect(g.tree).toBe(repo.git('rev-parse', 'HEAD^{tree}'));
    expect(workingTreeHash(repo.root)).toEqual({ tree: g.tree, error: null });
  });

  it('changes the tree hash for modified, new and deleted files, including untracked ones', () => {
    repo = tempRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    const clean = gitInfo(repo.root).tree;
    repo.write('a.txt', 'changed\n');
    const modified = gitInfo(repo.root);
    expect(modified.tree).not.toBe(clean);
    expect(modified.dirtyFiles).toBe(1);
    expect(modified.dirtyPaths).toEqual(['a.txt']);
    repo.write('new/untracked.txt', 'hi\n');
    const added = gitInfo(repo.root);
    expect(added.tree).not.toBe(modified.tree);
    expect(added.dirtyFiles).toBe(2);
    repo.write('a.txt', 'a\n');
    // deleting a tracked file
    unlinkSync(join(repo.root, 'b.txt'));
    const deleted = gitInfo(repo.root);
    expect(deleted.tree).not.toBe(added.tree);
    expect(deleted.dirtyPaths).toContain('b.txt');
  });

  it('ignores .gitignored files and the .isitdone directory', () => {
    repo = tempRepo({ files: { 'a.txt': 'a\n', '.gitignore': 'ignored/\n' } });
    const clean = gitInfo(repo.root).tree;
    repo.write('ignored/x.txt', 'x');
    repo.write('.isitdone/receipt.json', '{}');
    const g = gitInfo(repo.root);
    expect(g.tree).toBe(clean);
    expect(g.dirtyFiles).toBe(0);
  });

  it('never writes untracked file contents into .git/objects', () => {
    repo = tempRepo({ files: { 'a.txt': 'a\n' } });
    const count = () => Number(/count: (\d+)/.exec(repo!.git('count-objects'))?.[1] ?? -1);
    const before = count();
    repo.write('.env', 'AWS_SECRET_ACCESS_KEY=hunter2\n');
    const g = gitInfo(repo.root);
    expect(g.dirtyPaths).toContain('.env');
    // only tree objects may be added, never the blob of the untracked file
    const blob = repo.git('hash-object', '.env');
    expect(() => repo!.git('cat-file', '-e', blob)).toThrow();
    expect(count() - before).toBeLessThanOrEqual(1);
    expect(g.tree).toHaveLength(40);
  });

  it('sees edits inside embedded repositories and submodules', () => {
    repo = tempRepo({ files: { 'a.txt': 'a\n' } });
    const clean = gitInfo(repo.root).tree;
    // an embedded (untracked) repository
    const inner = tempRepo({ files: { 'lib.txt': 'v1\n' } });
    try {
      const target = join(repo.root, 'vendor', 'inner');
      mkdirSync(join(repo.root, 'vendor'), { recursive: true });
      cpSync(inner.root, target, { recursive: true });
      const withInner = gitInfo(repo.root).tree;
      expect(withInner).not.toBe(clean);
      writeFileSync(join(target, 'lib.txt'), 'v2\n');
      const edited = gitInfo(repo.root).tree;
      expect(edited).not.toBe(withInner);
      writeFileSync(join(target, 'lib.txt'), 'v1\n');
      expect(gitInfo(repo.root).tree).toBe(withInner);
      // a real submodule
      repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner.root.replace(/\\/g, '/'), 'sub');
      repo.commit('add submodule');
      const withSub = gitInfo(repo.root).tree;
      writeFileSync(join(repo.root, 'sub', 'lib.txt'), 'changed inside submodule\n');
      expect(gitInfo(repo.root).tree).not.toBe(withSub);
    } finally {
      inner.cleanup();
    }
  });

  it('hashes a repository whose submodule is not initialised or whose directory is gone', () => {
    repo = tempRepo({ files: { 'a.txt': 'a\n' } });
    const inner = tempRepo({ files: { 'lib.txt': 'v1\n' } });
    const clones = mkdtempSync(join(tmpdir(), 'isitdone-clone-'));
    try {
      repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner.root.replace(/\\/g, '/'), 'sub');
      repo.commit('add submodule');
      // a plain clone leaves sub/ as an empty directory (no .git inside): must not recurse into the parent forever
      const clone = join(clones, 'clone');
      repo.git('clone', '-q', repo.root, clone);
      const started = Date.now();
      const g = gitInfo(clone);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(g.treeError).toBeNull();
      expect(g.tree).toHaveLength(40);
      expect(gitInfo(clone).tree).toBe(g.tree);
      // the submodule directory removed altogether: the parent still hashes
      const before = gitInfo(repo.root);
      expect(before.treeError).toBeNull();
      rmSync(join(repo.root, 'sub'), { recursive: true, force: true });
      const gone = gitInfo(repo.root);
      expect(gone.treeError).toBeNull();
      expect(gone.tree).toHaveLength(40);
    } finally {
      inner.cleanup();
      rmSync(clones, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('does not touch the real index', () => {
    repo = tempRepo({ files: { 'a.txt': 'a\n' } });
    repo.write('new.txt', 'n');
    gitInfo(repo.root);
    expect(repo.git('diff', '--cached', '--name-only')).toBe('');
    expect(repo.git('status', '--porcelain')).toBe('?? new.txt');
  });

  it('handles a repo with no commits and a non-repo directory', () => {
    repo = tempRepo({ git: true });
    repo.write('a.txt', 'a');
    const g = gitInfo(repo.root);
    expect(g.isRepo).toBe(true);
    expect(g.head).toBeNull();
    expect(g.tree).toHaveLength(40);
    const plain = tempRepo({ git: false, files: { 'a.txt': 'a' } });
    try {
      const p = gitInfo(plain.root);
      expect(p.isRepo).toBe(false);
      expect(p.tree).toBe('nogit');
    } finally {
      plain.cleanup();
    }
  });
});

describe('receipts', () => {
  it('round-trips and is bound to the tree', () => {
    repo = tempRepo({ files: { 'package.json': '{"scripts":{"test":"x"}}' } });
    const g = gitInfo(repo.root);
    const ch = configHash(repo.root);
    expect(evaluateReceipt(repo.root, g, ch).state).toBe('NONE');
    writeReceipt(repo.root, { status: 'PASS', profile: 'full', head: g.head, branch: g.branch, tree: g.tree, dirtyFiles: 0, configHash: ch, checks: [passing()], claim: null, host: null });
    const ev = evaluateReceipt(repo.root, g, ch);
    expect(ev.state).toBe('PASS');
    expect(ev.receipt?.checks[0]?.id).toBe('test');
    expect(readReceipt(repo.root).valid).toBe(true);
  });

  it('goes STALE when files change and again PASS when reverted', () => {
    repo = tempRepo({ files: { 'a.txt': 'a\n', 'package.json': '{"scripts":{"test":"x"}}' } });
    const g = gitInfo(repo.root);
    const ch = configHash(repo.root);
    writeReceipt(repo.root, { status: 'PASS', profile: 'full', head: g.head, branch: g.branch, tree: g.tree, dirtyFiles: 0, configHash: ch, checks: [passing()], claim: null, host: null });
    repo.write('a.txt', 'b\n');
    const stale = evaluateReceipt(repo.root, gitInfo(repo.root), ch);
    expect(stale.state).toBe('STALE');
    expect(stale.reason).toMatch(/files changed/);
    repo.write('a.txt', 'a\n');
    expect(evaluateReceipt(repo.root, gitInfo(repo.root), ch).state).toBe('PASS');
  });

  it('goes STALE when the check configuration changes', () => {
    repo = tempRepo({ files: { 'package.json': '{"scripts":{"test":"x"}}' } });
    const g = gitInfo(repo.root);
    const ch = configHash(repo.root);
    writeReceipt(repo.root, { status: 'PASS', profile: 'full', head: g.head, branch: g.branch, tree: g.tree, dirtyFiles: 0, configHash: ch, checks: [], claim: null, host: null });
    repo.write('package.json', '{"scripts":{"test":"x || true"}}');
    const g2 = gitInfo(repo.root);
    const ev = evaluateReceipt(repo.root, g2, configHash(repo.root));
    expect(ev.state).toBe('STALE');
  });

  it('configHash ignores a version bump in package.json but not a script change', () => {
    repo = tempRepo({ files: { 'package.json': '{"version":"1.0.0","scripts":{"test":"x"}}' } });
    const a = configHash(repo.root);
    repo.write('package.json', '{"version":"1.0.1","scripts":{"test":"x"}}');
    expect(configHash(repo.root)).toBe(a);
    repo.write('package.json', '{"version":"1.0.1","scripts":{"test":"y"}}');
    expect(configHash(repo.root)).not.toBe(a);
  });

  it('rejects a hand-edited receipt', () => {
    repo = tempRepo({ files: { 'a.txt': 'a' } });
    const g = gitInfo(repo.root);
    const ch = configHash(repo.root);
    writeReceipt(repo.root, { status: 'FAIL', profile: 'full', head: g.head, branch: g.branch, tree: g.tree, dirtyFiles: 0, configHash: ch, checks: [], claim: null, host: null });
    const f = join(repo.root, '.isitdone', 'receipt.json');
    writeFileSync(f, readFileSync(f, 'utf8').replace('"FAIL"', '"PASS"'));
    const ev = evaluateReceipt(repo.root, g, ch);
    expect(ev.state).toBe('NONE');
    expect(ev.reason).toMatch(/signature/);
  });

  it('reports FAIL receipts as FAIL on the same tree', () => {
    repo = tempRepo({ files: { 'a.txt': 'a' } });
    const g = gitInfo(repo.root);
    const ch = configHash(repo.root);
    writeReceipt(repo.root, { status: 'FAIL', profile: 'full', head: g.head, branch: g.branch, tree: g.tree, dirtyFiles: 0, configHash: ch, checks: [], claim: 'done', host: 'claude-code' });
    expect(evaluateReceipt(repo.root, g, ch).state).toBe('FAIL');
  });

  it('writes a .gitignore inside .isitdone so state never gets committed', () => {
    repo = tempRepo({ files: { 'a.txt': 'a' } });
    const g = gitInfo(repo.root);
    writeReceipt(repo.root, { status: 'PASS', profile: 'full', head: g.head, branch: g.branch, tree: g.tree, dirtyFiles: 0, configHash: 'x', checks: [], claim: null, host: null });
    expect(readFileSync(join(repo.root, '.isitdone', '.gitignore'), 'utf8')).toBe('*\n');
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});
