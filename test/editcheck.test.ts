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

describe('checkEditedFile', () => {
  it('warns when an edit weakens a test file, with a note the agent can act on', () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'src/math.ts': 'export const add = (a, b) => a + b;\n' } });
    repo.write('src/math.test.ts', "it.skip('adds', () => { expect(add(1, 1)).toBe(2); });\nit('subtracts', () => { expect(sub(2, 1)).toBe(1); });\n");
    const r = checkEditedFile(repo.root, join(repo.root, 'src', 'math.test.ts'));
    expect(r?.path).toBe('src/math.test.ts');
    expect(r?.notable.map((f) => f.id)).toEqual(['skip-added']);
    expect(r?.note).toMatch(/your edit to src\/math\.test\.ts weakened the tests/);
    expect(r?.note).toMatch(/line 1: test skipped/);
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
    const plain = tempRepo({ git: false, files: { 'a.test.ts': TEST } });
    try {
      expect(checkEditedFile(plain.root, 'a.test.ts')).toBeNull();
    } finally {
      plain.cleanup();
    }
  });

  it('normalises paths', () => {
    expect(toRepoPath('/repo', '/repo/src/a.test.ts')).toBe('src/a.test.ts');
    expect(toRepoPath('C:\\repo', 'C:\\repo\\src\\a.test.ts')).toBe('src/a.test.ts');
  });
});
