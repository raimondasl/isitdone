import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEditedFile, toRepoPath } from '../src/editcheck.js';
import { tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const TEST = "it('adds', () => { expect(add(1, 1)).toBe(2); });\nit('subtracts', () => { expect(sub(2, 1)).toBe(1); });\n";
const WEAKER = "it.skip('adds', () => { expect(add(1, 1)).toBe(2); });\nit('subtracts', () => { expect(sub(2, 1)).toBe(1); });\n";

describe('checkEditedFile', () => {
  it('warns when an edit weakens a test file, with a note the agent can act on', () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'src/math.ts': 'export const add = (a, b) => a + b;\n' } });
    repo.write('src/math.test.ts', WEAKER);
    const r = checkEditedFile(repo.root, join(repo.root, 'src', 'math.test.ts'));
    expect(r?.path).toBe('src/math.test.ts');
    expect(r?.notable.map((f) => f.id)).toEqual(['skip-added']);
    expect(r?.note).toMatch(/after your edit, src\/math\.test\.ts has weaker tests than HEAD \(Tests 2 -> 2/);
    expect(r?.note).toMatch(/line 1: test skipped/);
    expect(r?.note).toMatch(/or the change was already there before your edit/);
    expect(r?.note).toMatch(/Stop hook will run the full checks/);
  });

  it('is quiet for a harmless edit, a non-test file, and an unchanged file', () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'src/math.ts': 'export const add = (a, b) => a + b;\n' } });
    repo.write('src/math.test.ts', TEST + "it('multiplies', () => { expect(mul(2, 3)).toBe(6); });\n");
    expect(checkEditedFile(repo.root, 'src/math.test.ts')?.note).toBeNull();
    repo.write('src/math.ts', 'export const add = (a, b) => a + b + 0;\n');
    const src = checkEditedFile(repo.root, 'src/math.ts');
    expect(src?.report).toBeNull();
    expect(src?.note).toBeNull();
    expect(checkEditedFile(repo.root, 'src/other.test.ts')?.report).toBeNull();
  });

  it('handles config files, paths outside the repo, and non-repos', () => {
    repo = tempRepo({ files: { 'package.json': '{"scripts":{"test":"vitest run"}}\n' } });
    repo.write('package.json', '{"scripts":{"test":"vitest run || true"}}\n');
    const r = checkEditedFile(repo.root, join(repo.root, 'package.json'));
    expect(r?.notable.map((f) => f.id)).toEqual(['config-weakened']);
    expect(checkEditedFile(repo.root, join(repo.root, '..', 'elsewhere.test.ts'))).toBeNull();
    if (process.platform === 'win32') {
      // another drive: relative() cannot express it with "..", so the result is absolute
      const drive = repo.root.startsWith('Z:') ? 'Y:' : 'Z:';
      expect(checkEditedFile(repo.root, `${drive}\\elsewhere\\tests\\a.test.ts`)).toBeNull();
    }
    const plain = tempRepo({ git: false, files: { 'a.test.ts': TEST } });
    try {
      expect(checkEditedFile(plain.root, 'a.test.ts')).toBeNull();
    } finally {
      plain.cleanup();
    }
  });

  it('resolves a relative path against the session cwd, not the repository top', () => {
    repo = tempRepo({ files: { 'packages/app/tests/math.test.ts': TEST, 'tests/math.test.ts': TEST } });
    repo.write('packages/app/tests/math.test.ts', WEAKER);
    const r = checkEditedFile(join(repo.root, 'packages', 'app'), 'tests/math.test.ts');
    expect(r?.path).toBe('packages/app/tests/math.test.ts');
    expect(r?.notable.map((f) => f.id)).toEqual(['skip-added']);
    // the same-named, unchanged top-level file is not what was edited
    expect(checkEditedFile(repo.root, 'tests/math.test.ts')?.report).toBeNull();
  });

  it('pairs an unstaged rename with its old file: a pure move is quiet, a move plus a skip is reported once under the new name', () => {
    repo = tempRepo({ files: { 'tests/a.test.ts': TEST } });
    renameSync(join(repo.root, 'tests', 'a.test.ts'), join(repo.root, 'tests', 'b.test.ts'));
    expect(checkEditedFile(repo.root, 'tests/b.test.ts')?.note).toBeNull();
    repo.write('tests/b.test.ts', WEAKER);
    const r = checkEditedFile(repo.root, 'tests/b.test.ts');
    expect(r?.path).toBe('tests/b.test.ts');
    expect(r?.notable.map((f) => f.id)).toEqual(['skip-added']);
    expect(r?.note).toMatch(/tests\/b\.test\.ts has weaker tests/);
  });

  it('uses a caller-supplied diff', () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST } });
    repo.write('src/math.test.ts', WEAKER);
    let calls = 0;
    const empty = () => {
      calls++;
      return { files: [], base: 'HEAD', error: null };
    };
    expect(checkEditedFile(repo.root, 'src/math.test.ts', 'HEAD', empty)?.report).toBeNull();
    expect(checkEditedFile(repo.root, 'src/math.ts', 'HEAD', empty)?.report).toBeNull();
    expect(calls).toBe(1); // a non-test file never asks for the diff
  });

  it('normalises paths', () => {
    if (process.platform === 'win32') {
      expect(toRepoPath('C:\\repo', 'C:\\repo\\src\\a.test.ts')).toBe('src/a.test.ts');
      expect(toRepoPath('C:\\repo', 'src\\a.test.ts')).toBe('src/a.test.ts');
      expect(toRepoPath('C:\\repo', 'tests\\a.test.ts', 'C:\\repo\\packages\\app')).toBe('packages/app/tests/a.test.ts');
    } else {
      expect(toRepoPath('/repo', '/repo/src/a.test.ts')).toBe('src/a.test.ts');
      expect(toRepoPath('/repo', 'src/a.test.ts')).toBe('src/a.test.ts');
      expect(toRepoPath('/repo', 'tests/a.test.ts', '/repo/packages/app')).toBe('packages/app/tests/a.test.ts');
    }
  });
});
