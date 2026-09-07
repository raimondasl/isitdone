import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectDiff, parseUnifiedDiff, readAtBase, readNow } from '../src/diff.js';
import { tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 line1
-old2
+new2
 line3
 line4
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
index 3333333..4444444 100644
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-x
+y
diff --git a/gone.py b/gone.py
deleted file mode 100644
index 5555555..0000000
--- a/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-def test_a():
-    assert True
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..6666666
Binary files /dev/null and b/img.png differ
diff --git a/fresh.go b/fresh.go
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ b/fresh.go
@@ -0,0 +1,2 @@
+package x
+func TestA(t *testing.T) {}
`;

describe('parseUnifiedDiff', () => {
  it('parses modified, renamed, deleted, binary and added files with line numbers', () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['src/a.ts', 'modified', false],
      ['new.txt', 'renamed', false],
      ['gone.py', 'deleted', false],
      ['img.png', 'added', true],
      ['fresh.go', 'added', false],
    ]);
    const a = files[0]!;
    expect(a.hunks[0]?.lines.map((l) => `${l.kind}${l.text}:${l.oldNo}/${l.newNo}`)).toEqual([' line1:1/1', '-old2:2/null', '+new2:null/2', ' line3:3/3', ' line4:4/4']);
    expect(files[1]?.oldPath).toBe('old.txt');
    expect(files[2]?.hunks[0]?.lines.every((l) => l.kind === '-')).toBe(true);
    expect(files[4]?.hunks[0]?.lines.map((l) => l.newNo)).toEqual([1, 2]);
  });

  it('handles quoted paths and CRLF', () => {
    const files = parseUnifiedDiff('diff --git "a/sp ace.ts" "b/sp ace.ts"\r\n--- "a/sp ace.ts"\r\n+++ "b/sp ace.ts"\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n');
    expect(files[0]?.path).toBe('sp ace.ts');
    expect(files[0]?.hunks[0]?.lines.map((l) => l.text)).toEqual(['a', 'b']);
  });
});

describe('collectDiff', () => {
  it('includes staged, unstaged, deleted and untracked files against HEAD', () => {
    repo = tempRepo({ files: { 'a.test.ts': 'it("x", () => {});\n', 'b.ts': 'export {};\n', 'c.txt': 'c\n' } });
    repo.write('a.test.ts', 'it.only("x", () => {});\n');
    repo.write('b.ts', 'export const b = 1;\n');
    repo.git('add', 'b.ts');
    unlinkSync(join(repo.root, 'c.txt'));
    repo.write('new.test.ts', 'it.skip("y", () => {});\n');
    const d = collectDiff(repo.root);
    expect(d.error).toBeNull();
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f.status]));
    expect(byPath).toEqual({ 'a.test.ts': 'modified', 'b.ts': 'modified', 'c.txt': 'deleted', 'new.test.ts': 'added' });
    const added = d.files.find((f) => f.path === 'new.test.ts')!;
    expect(added.hunks[0]?.lines).toEqual([{ kind: '+', text: 'it.skip("y", () => {});', newNo: 1, oldNo: null }]);
    expect(readAtBase(repo.root, 'a.test.ts')).toBe('it("x", () => {});\n');
    expect(readNow(repo.root, 'a.test.ts')).toBe('it.only("x", () => {});\n');
    expect(readAtBase(repo.root, 'new.test.ts')).toBeNull();
    expect(readNow(repo.root, 'c.txt')).toBeNull();
  });

  it('diffs against a base ref and ignores .isitdone', () => {
    repo = tempRepo({ files: { 'x.txt': '1\n' } });
    const first = repo.git('rev-parse', 'HEAD');
    repo.write('x.txt', '2\n');
    repo.commit('second');
    repo.write('.isitdone/receipt.json', '{}');
    expect(collectDiff(repo.root).files).toEqual([]);
    const d = collectDiff(repo.root, first);
    expect(d.files.map((f) => f.path)).toEqual(['x.txt']);
    expect(readAtBase(repo.root, 'x.txt', first)).toBe('1\n');
    // an explicit base that does not exist is an error, never "everything is new"
    const missing = collectDiff(repo.root, 'no-such-ref');
    expect(missing.error).toMatch(/base no-such-ref not found/);
    expect(missing.files).toEqual([]);
  });

  it('works in a repo with no commits (everything is untracked)', () => {
    repo = tempRepo({ git: true });
    repo.write('t_test.go', 'package x\n');
    const d = collectDiff(repo.root);
    expect(d.error).toBeNull();
    expect(d.files.map((f) => [f.path, f.status])).toEqual([['t_test.go', 'added']]);
  });
});
