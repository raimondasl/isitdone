import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, type DiffFile } from '../src/diff.js';
import { countTests, formatSummaryLine, isTestConfigFile, isTestFile, scanIntegrity, type Finding } from '../src/integrity.js';

/** Build a diff for one modified file from its before/after text. */
function modified(path: string, before: string, after: string): { files: DiffFile[]; readBefore: (p: string) => string | null; readAfter: (p: string) => string | null } {
  const b = before.split('\n');
  const a = after.split('\n');
  const lines: string[] = [];
  // naive: all removed then all added, one hunk
  for (const l of b) lines.push('-' + l);
  for (const l of a) lines.push('+' + l);
  const text = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${b.length} +1,${a.length} @@\n${lines.join('\n')}\n`;
  return { files: parseUnifiedDiff(text), readBefore: () => before, readAfter: () => after };
}

function ids(findings: Finding[]): string[] {
  return findings.map((f) => `${f.id}:${f.severity}`);
}

describe('isTestFile / isTestConfigFile', () => {
  it('classifies paths', () => {
    for (const p of ['src/a.test.ts', 'src/a.spec.js', '__tests__/x.tsx', 'tests/unit/y.mjs', 'tests/test_x.py', 'pkg/x_test.go', 'test_api.py', 'conftest.py']) expect(isTestFile(p), p).toBe(true);
    for (const p of ['src/a.ts', 'testing/README.md', 'contest.py', 'tests/fixtures/data.json', 'latest.go']) expect(isTestFile(p), p).toBe(false);
    for (const p of ['jest.config.js', 'vitest.config.mts', 'package.json', 'pyproject.toml', '.github/workflows/ci.yml', 'Makefile', 'pytest.ini']) expect(isTestConfigFile(p), p).toBe(true);
    for (const p of ['src/config.ts', 'README.md', 'tsconfig.json']) expect(isTestConfigFile(p), p).toBe(false);
  });
});

describe('countTests', () => {
  it('counts js, python and go', () => {
    expect(countTests('js', 'it("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\ntest.skip("b", () => {});\ndescribe("d", () => { it.each([1])("c", () => {}); });')).toEqual({ tests: 3, assertions: 2, skipped: 1 });
    expect(countTests('py', 'def test_a():\n    assert 1\n    self.assertEqual(1, 1)\n@pytest.mark.skip\ndef test_b():\n    pass\n')).toEqual({ tests: 2, assertions: 2, skipped: 1 });
    expect(countTests('go', 'func TestA(t *testing.T) {\n\tt.Skip("x")\n\tif x { t.Fatal("no") }\n\tassert.Equal(t, 1, 1)\n}\n')).toEqual({ tests: 1, assertions: 2, skipped: 1 });
    expect(countTests('other', 'anything')).toEqual({ tests: 0, assertions: 0, skipped: 0 });
  });
});

describe('scanIntegrity: test files', () => {
  it('flags .only and new skips, but not a moved skip', () => {
    const d = modified('a.test.ts', 'it("a", () => {});\nit.skip("b", () => {});\nit("c", () => {});', 'it.only("a", () => {});\nit("c", () => {});\nit.skip("b", () => {});\nit.skip("d", () => {});');
    const r = scanIntegrity(d.files, d);
    expect(ids(r.findings)).toEqual(['only-added:critical', 'skip-added:high']);
    expect(r.findings[1]?.line).toBe(4);
    expect(r.blocking.map((f) => f.id)).toEqual(['only-added', 'skip-added']);
  });

  it('flags removed tests and removed assertions with a summary line', () => {
    const before = 'it("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\nit("b", () => { expect(3).toBe(3); });\nit("c", () => { expect(4).toBe(4); });';
    const after = 'it("a", () => { expect(1).toBe(1); });';
    const r = scanIntegrity(modified('a.test.ts', before, after).files, modified('a.test.ts', before, after));
    expect(ids(r.findings)).toEqual(['tests-removed:high']);
    expect(r.summary).toEqual({ testsBefore: 3, testsAfter: 1, assertionsBefore: 4, assertionsAfter: 1, skippedBefore: 0, skippedAfter: 0 });
    expect(formatSummaryLine(r.summary)).toBe('Tests 3 -> 1   Assertions 4 -> 1   Skipped 0 -> 0');
    const only = modified('a.test.ts', 'it("a", () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3); });', 'it("a", () => { expect(1).toBe(1); });');
    const r2 = scanIntegrity(only.files, only);
    expect(ids(r2.findings)).toEqual(['assertions-removed:high']); // 2 of 3 assertions gone
    const ten = Array.from({ length: 10 }, (_, i) => `expect(${i}).toBe(${i});`).join('\n');
    const nine = Array.from({ length: 9 }, (_, i) => `expect(${i}).toBe(${i});`).join('\n');
    const one = modified('a.test.ts', `it("a", () => {\n${ten}\n});`, `it("a", () => {\n${nine}\n});`);
    expect(ids(scanIntegrity(one.files, one).findings)).toEqual(['assertions-removed:medium']);
  });

  it('flags weakened assertions with before/after evidence', () => {
    const d = modified('a.test.ts', 'expect(result).toStrictEqual({ a: 1 });\nexpect(spy).toHaveBeenCalledWith(1);\nexpect(() => f()).toThrow("bad input");', 'expect(result).toEqual({ a: 1 });\nexpect(spy).toHaveBeenCalled();\nexpect(() => f()).toThrow();');
    const r = scanIntegrity(d.files, d);
    expect(r.findings.map((f) => f.message)).toEqual(['assertion weakened: toStrictEqual -> toEqual', 'assertion weakened: toHaveBeenCalledWith -> toHaveBeenCalled', 'assertion weakened: toThrow(message) -> toThrow()']);
    expect(r.findings[0]?.evidence).toBe('- expect(result).toStrictEqual({ a: 1 });\n+ expect(result).toEqual({ a: 1 });');
    expect(r.blocking).toEqual([]);
  });

  it('does not flag a weaker matcher on a different subject', () => {
    const d = modified('a.test.ts', 'expect(a).toStrictEqual(1);', 'expect(a).toStrictEqual(1);\nexpect(b).toEqual(2);');
    expect(scanIntegrity(d.files, d).findings).toEqual([]);
  });

  it('flags widened tolerances and swallowed errors', () => {
    const d = modified('m.test.ts', 'expect(x).toBeCloseTo(1.5, 5);\nawait run();', 'expect(x).toBeCloseTo(1.5, 1);\ntry {\n  await run();\n} catch (e) {\n}');
    const r = scanIntegrity(d.files, d);
    expect(ids(r.findings)).toEqual(['error-swallowed:medium', 'tolerance-widened:low']);
    const py = modified('test_m.py', 'assert x == pytest.approx(1.0, rel=1e-6)\nwith pytest.raises(ValueError):\n    f()', 'assert x == pytest.approx(1.0, rel=1e-2)\nwith pytest.raises(Exception):\n    f()\ntry:\n    g()\nexcept Exception:\n    pass');
    const r2 = scanIntegrity(py.files, py);
    expect(ids(r2.findings).sort()).toEqual(['assertion-weakened:medium', 'error-swallowed:medium', 'tolerance-widened:low']);
  });

  it('flags a deleted test file and python/go skips', () => {
    const deleted = parseUnifiedDiff('diff --git a/tests/test_x.py b/tests/test_x.py\ndeleted file mode 100644\n--- a/tests/test_x.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-def test_a():\n-    assert 1\n');
    const r = scanIntegrity(deleted, { readBefore: () => 'def test_a():\n    assert 1\n', readAfter: () => null });
    expect(ids(r.findings)).toEqual(['test-file-deleted:high']);
    expect(r.summary.testsBefore).toBe(1);
    expect(r.summary.testsAfter).toBe(0);
    const py = modified('test_x.py', 'def test_a():\n    assert 1', '@pytest.mark.skip(reason="flaky")\ndef test_a():\n    assert 1');
    expect(ids(scanIntegrity(py.files, py).findings)).toEqual(['skip-added:high']);
    const go = modified('x_test.go', 'func TestA(t *testing.T) {\n\tassert.Equal(t, 1, 1)\n}', 'func TestA(t *testing.T) {\n\tt.Skip("later")\n\tassert.Equal(t, 1, 1)\n}');
    expect(ids(scanIntegrity(go.files, go).findings)).toEqual(['skip-added:high']);
  });

  it('reports suppressed findings without blocking, and flags new suppressions in ci mode', () => {
    const d = modified('a.test.ts', 'it("a", () => {});', 'it.skip("a", () => {}); // isitdone: allow needs the staging API');
    const r = scanIntegrity(d.files, d);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.suppressed).toBe('needs the staging API');
    expect(r.blocking).toEqual([]);
    const ci = scanIntegrity(d.files, { ...d, ci: true });
    expect(ids(ci.findings).sort()).toEqual(['skip-added:high', 'suppression-added:high']);
    const above = modified('b.test.ts', 'it("a", () => {});', '// isitdone: allow flaky upstream\nit.skip("a", () => {});');
    expect(scanIntegrity(above.files, above).findings[0]?.suppressed).toBe('flaky upstream');
  });

  it('ignores non-test source files and legitimate refactors', () => {
    const src = modified('src/a.ts', 'export const a = 1;', 'export const a = 2; // it.skip is mentioned in a comment');
    expect(scanIntegrity(src.files, src).findings).toEqual([]);
    const refactor = modified('a.test.ts', 'it("a", () => { expect(f(1)).toBe(2); });\nit("b", () => { expect(f(2)).toBe(3); });', 'it.each([[1, 2], [2, 3]])("f(%i)", (i, o) => { expect(f(i)).toBe(o); });\nit("c", () => { expect(f(3)).toBe(4); });');
    const r = scanIntegrity(refactor.files, refactor);
    expect(r.findings).toEqual([]);
  });
});

describe('scanIntegrity: configuration', () => {
  it('flags neutered scripts, ignored failures and disabled CI steps', () => {
    const pkg = modified('package.json', '  "test": "vitest run",', '  "test": "vitest run || true",');
    expect(ids(scanIntegrity(pkg.files, pkg).findings)).toEqual(['config-weakened:critical']);
    const jest = modified('jest.config.js', 'module.exports = {};', 'module.exports = { testPathIgnorePatterns: ["auth"] };');
    expect(scanIntegrity(jest.files, jest).findings[0]?.message).toMatch(/ignore pattern/);
    const wf = modified('.github/workflows/ci.yml', '      - run: npm test\n', '      - run: npm run build\n        continue-on-error: true\n');
    const r = scanIntegrity(wf.files, wf);
    expect(ids(r.findings).sort()).toEqual(['config-weakened:critical', 'test-step-removed:high']);
    const still = modified('.github/workflows/ci.yml', '      - run: npm test\n', '      - run: npm ci\n      - run: npm test\n');
    expect(scanIntegrity(still.files, still).findings).toEqual([]);
    const pytest = modified('pyproject.toml', 'addopts = "-q"', 'addopts = "-q --ignore=tests/integration"');
    expect(scanIntegrity(pytest.files, pytest).findings[0]?.message).toMatch(/pytest collection narrowed/);
  });

  it('flags a deleted workflow and changed snapshots', () => {
    const wf = parseUnifiedDiff('diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml\ndeleted file mode 100644\n--- a/.github/workflows/test.yml\n+++ /dev/null\n@@ -1 +0,0 @@\n-name: test\n');
    expect(ids(scanIntegrity(wf, { readBefore: () => 'name: test\n', readAfter: () => null }).findings)).toEqual(['ci-workflow-deleted:high']);
    const snap = modified('__snapshots__/a.test.ts.snap', 'exports[`a`] = `1`;', 'exports[`a`] = `2`;');
    expect(ids(scanIntegrity(snap.files, snap).findings)).toEqual(['snapshot-changed:low']);
  });
});
