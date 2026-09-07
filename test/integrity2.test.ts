/**
 * Cases from the false-positive/false-negative hunt: legitimate refactors that must stay quiet
 * (or low), and tampering that must be caught at medium or above.
 */
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, type DiffFile } from '../src/diff.js';
import { countTests, scanIntegrity, type Finding, type ScanOptions } from '../src/integrity.js';

interface Case {
  files: DiffFile[];
  readBefore: ScanOptions['readBefore'];
  readAfter: ScanOptions['readAfter'];
}

/** A diff for one modified file (all lines removed then added in one hunk, like a rewrite). */
function modified(path: string, before: string, after: string): Case {
  const b = before.split('\n');
  const a = after.split('\n');
  const text = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${b.length} +1,${a.length} @@\n${[...b.map((l) => '-' + l), ...a.map((l) => '+' + l)].join('\n')}\n`;
  return { files: parseUnifiedDiff(text), readBefore: () => before, readAfter: () => after };
}

/** Several files: {path: [before|null, after|null]}. */
function multi(spec: Record<string, [string | null, string | null]>): Case {
  let text = '';
  for (const [path, [before, after]] of Object.entries(spec)) {
    if (before === null && after === null) continue;
    const b = before === null ? [] : before.split('\n');
    const a = after === null ? [] : after.split('\n');
    text += `diff --git a/${path} b/${path}\n${before === null ? 'new file mode 100644\n' : ''}${after === null ? 'deleted file mode 100644\n' : ''}--- ${before === null ? '/dev/null' : 'a/' + path}\n+++ ${after === null ? '/dev/null' : 'b/' + path}\n@@ -1,${b.length} +1,${a.length} @@\n${[...b.map((l) => '-' + l), ...a.map((l) => '+' + l)].join('\n')}\n`;
  }
  return { files: parseUnifiedDiff(text), readBefore: (p) => spec[p]?.[0] ?? null, readAfter: (p) => spec[p]?.[1] ?? null };
}

const ids = (f: Finding[]) => f.map((x) => `${x.id}:${x.severity}`);
const scan = (c: Case, ci = false) => scanIntegrity(c.files, { readBefore: c.readBefore, readAfter: c.readAfter, ci });
const blocking = (c: Case) => scan(c).blocking.map((f) => f.id);
const medPlus = (c: Case) => scan(c).findings.filter((f) => f.severity !== 'low').map((f) => f.id);

describe('legitimate refactors stay quiet', () => {
  it('it.each with the same rows is not "tests removed"', () => {
    const before = "describe('add', () => {\n  it('adds 1+1', () => { expect(add(1, 1)).toBe(2); });\n  it('adds 2+3', () => { expect(add(2, 3)).toBe(5); });\n  it('adds -1+1', () => { expect(add(-1, 1)).toBe(0); });\n});";
    const after = "describe('add', () => {\n  it.each([\n    [1, 1, 2],\n    [2, 3, 5],\n    [-1, 1, 0],\n  ])('adds %i+%i', (a, b, expected) => {\n    expect(add(a, b)).toBe(expected);\n  });\n});";
    expect(countTests('js', after).tests).toBe(3);
    expect(blocking(modified('src/add.test.ts', before, after))).toEqual([]);
    // fewer rows than tests is still a drop
    const two = after.replace('    [-1, 1, 0],\n', '');
    expect(medPlus(modified('src/add.test.ts', before, two))).toEqual(['tests-removed']);
    // tagged-template table
    expect(countTests('js', "test.each`\n  a | b | c\n  ${1} | ${1} | ${2}\n  ${2} | ${3} | ${5}\n`('x', () => {});").tests).toBe(2);
    // a variable table is unknown: one test, but the loop/table signal keeps the drop at low
    expect(blocking(modified('src/add.test.ts', before, "it.each(cases)('adds', (a, b, e) => { expect(add(a, b)).toBe(e); });"))).toEqual([]);
  });

  it('describe.each is treated as a table refactor (low)', () => {
    const before = "describe('a', () => { it('x', () => { expect(f(1)).toBe(1); }); it('y', () => { expect(f(2)).toBe(2); }); });\ndescribe('b', () => { it('x', () => { expect(f(1)).toBe(1); }); it('y', () => { expect(f(2)).toBe(2); }); });";
    const after = "describe.each([['a'], ['b']])('%s', () => { it('x', () => { expect(f(1)).toBe(1); }); it('y', () => { expect(f(2)).toBe(2); }); });";
    expect(blocking(modified('src/x.test.ts', before, after))).toEqual([]);
  });

  it('tests moved to another file in the same diff are not removed', () => {
    const util = "describe('parse', () => {\n  it('parses ints', () => { expect(p(1)).toBe(1); });\n  it('parses negatives', () => { expect(p(-2)).toBe(-2); });\n});\ndescribe('format', () => {\n  it('formats ints', () => { expect(fmt(3)).toBe('3'); });\n  it('formats negatives', () => { expect(fmt(-4)).toBe('-4'); });\n});";
    const utilAfter = "describe('parse', () => {\n  it('parses ints', () => { expect(p(1)).toBe(1); });\n  it('parses negatives', () => { expect(p(-2)).toBe(-2); });\n});";
    const formatNew = "describe('format', () => {\n  it('formats ints', () => { expect(fmt(3)).toBe('3'); });\n  it('formats negatives', () => { expect(fmt(-4)).toBe('-4'); });\n});";
    const c = multi({ 'src/util.test.ts': [util, utilAfter], 'src/format.test.ts': [null, formatNew] });
    const r = scan(c);
    expect(r.blocking).toEqual([]);
    expect(ids(r.findings)).toEqual(['tests-moved:low']);
    expect(r.summary.testsBefore).toBe(4);
    expect(r.summary.testsAfter).toBe(4);
    // moving only one of the two removed tests still reports the other as removed
    const half = multi({ 'src/util.test.ts': [util, utilAfter], 'src/format.test.ts': [null, "it('formats ints', () => { expect(fmt(3)).toBe('3'); });"] });
    expect(medPlus(half)).toEqual(['tests-removed']);
  });

  it('an unstaged whole-file rename (deleted + identical untracked copy) is not a deletion', () => {
    const content = "it('a', () => { expect(f(1)).toBe(1); });\nit('b', () => { expect(f(2)).toBe(2); });\n";
    const c = multi({ 'src/util.test.ts': [content, null], 'src/__tests__/util.test.ts': [null, content.replace(/\n/g, '\r\n')] });
    expect(scan(c).findings).toEqual([]);
    const wf = multi({ '.github/workflows/ci.yml': ['name: ci\n', null], '.github/workflows/test.yml': [null, 'name: ci\n'] });
    expect(scan(wf).findings).toEqual([]);
  });

  it('a test file moved out of the test locations is a deletion', () => {
    const files = parseUnifiedDiff('diff --git a/tests/a.test.js b/src/a.js\nsimilarity index 100%\nrename from tests/a.test.js\nrename to src/a.js\n');
    const r = scanIntegrity(files, { readBefore: () => "it('a', () => {});", readAfter: () => "it('a', () => {});" });
    expect(ids(r.findings)).toEqual(['test-file-deleted:high']);
  });

  it('assertions extracted into a helper called from several tests are low, not high', () => {
    const before = "it('a', () => { expect(r.ok).toBe(true); expect(r.code).toBe(200); expect(r.body).toBeDefined(); });\nit('b', () => { expect(r.ok).toBe(true); expect(r.code).toBe(200); expect(r.body).toBeDefined(); });\nit('c', () => { expect(r.ok).toBe(true); expect(r.code).toBe(200); expect(r.body).toBeDefined(); });";
    const after = "function expectOk(r) {\n  expect(r.ok).toBe(true);\n  expect(r.code).toBe(200);\n  expect(r.body).toBeDefined();\n}\nit('a', () => { expectOk(r); });\nit('b', () => { expectOk(r); });\nit('c', () => { expectOk(r); });";
    const r = scan(modified('src/x.test.ts', before, after));
    expect(r.blocking).toEqual([]);
    expect(ids(r.findings)).toEqual(['assertions-removed:low']);
  });

  it('callback tests converted to async keep the same strength', () => {
    const before = "it('loads', (done) => {\n  load((err, data) => {\n    expect(err).toBeNull();\n    expect(data).toEqual({ a: 1 });\n    expect(data.a).toBe(1);\n    done();\n  });\n});";
    const after = "it('loads', async () => {\n  const data = await load();\n  expect(data).toEqual({ a: 1 });\n  expect(data.a).toBe(1);\n});";
    expect(scan(modified('src/x.test.ts', before, after)).findings).toEqual([]);
    // re-indented strong assertion next to a new existence check is not a downgrade
    const after2 = "it('loads', async () => {\n  const data = await load();\n  expect(data).toBeDefined();\n    expect(data).toEqual({ a: 1 });\n  expect(data.a).toBe(1);\n});";
    expect(medPlus(modified('src/x.test.ts', before, after2))).toEqual([]);
  });

  it('assertions wrapped in a loop are low', () => {
    const before = "it('x', () => {\n  expect(f(1)).toBe(2);\n  expect(f(2)).toBe(3);\n  expect(f(3)).toBe(4);\n  expect(f(4)).toBe(5);\n});";
    const after = "it('x', () => {\n  for (const [i, o] of [[1, 2], [2, 3], [3, 4], [4, 5]]) {\n    expect(f(i)).toBe(o);\n  }\n});";
    const r = scan(modified('src/x.test.ts', before, after));
    expect(r.blocking).toEqual([]);
    expect(ids(r.findings)).toEqual(['assertions-removed:low']);
  });

  it('snapshot replaced by explicit assertions on the same value is not a downgrade', () => {
    const before = "it('cfg', () => { expect(cfg).toMatchSnapshot(); });";
    const after = "it('cfg', () => {\n  expect(cfg).toBeDefined();\n  expect(cfg.name).toBe('x');\n  expect(cfg.port).toBe(80);\n  expect(Object.keys(cfg)).toEqual(['name', 'port']);\n});";
    expect(scan(modified('src/x.test.ts', before, after)).findings).toEqual([]);
    // but a bare existence check replacing the snapshot is
    expect(medPlus(modified('src/x.test.ts', before, "it('cfg', () => { expect(cfg).toBeDefined(); });"))).toEqual(['assertion-weakened']);
  });

  it('a new test.todo placeholder is low; converting a real test to todo is high', () => {
    const before = "it('a', () => { expect(f(1)).toBe(1); });";
    expect(ids(scan(modified('src/x.test.ts', before, before + "\nit('b', () => { expect(f(2)).toBe(2); });\ntest.todo('c');")).findings)).toEqual(['todo-added:low']);
    expect(ids(scan(modified('src/x.test.ts', before, "test.todo('a');")).findings)).toEqual(['skip-added:high', 'tests-removed:medium']);
  });

  it('an it.skip moved to another hunk of the same file is not new', () => {
    const files = parseUnifiedDiff("diff --git a/x.test.ts b/x.test.ts\n--- a/x.test.ts\n+++ b/x.test.ts\n@@ -1,3 +1,2 @@\n-it.skip('later', () => {});\n it('a', () => {});\n it('b', () => {});\n@@ -20,2 +19,3 @@\n it('y', () => {});\n it('z', () => {});\n+it.skip('later', () => {});\n");
    const r = scanIntegrity(files, { readBefore: () => 'x', readAfter: () => 'x' });
    expect(r.findings).toEqual([]);
  });

  it('skip and only inside block comments and docstrings are ignored', () => {
    const js = modified('src/x.test.ts', "it('a', () => {});", "/*\n * TODO: it.only('x') and test.skip( are mentioned here\n */\nit('a', () => {});");
    expect(scan(js).findings).toEqual([]);
    const py = modified('tests/test_x.py', 'def test_a():\n    assert x == 1', '"""Module docs.\n\nUse @pytest.mark.skip for slow tests.\n"""\ndef test_a():\n    assert x == 1');
    expect(scan(py).findings).toEqual([]);
  });

  it('commented-out assertions do not count as assertions', () => {
    expect(countTests('js', "it('a', () => {\n  // expect(f(1)).toBe(1);\n  /* expect(f(2)).toBe(2); */\n  expect(f(3)).toBe(3);\n});")).toMatchObject({ tests: 1, assertions: 1, skipped: 0 });
    expect(countTests('py', 'def test_a():\n    # assert False\n    """assert in docstring"""\n    assert True').assertions).toBe(1);
  });

  it('non-ASCII test names count', () => {
    expect(countTests('py', 'def test_ü():\n    assert x == 1').tests).toBe(1);
    expect(medPlus(modified('tests/test_x.py', 'def test_a():\n    assert x == 1', 'def test_ü():\n    assert x == 1'))).toEqual([]);
  });

  it('Go table-driven and helper refactors are not removals', () => {
    const before = 'func TestA(t *testing.T) {\n\tif add(1, 1) != 2 { t.Errorf("no") }\n}\nfunc TestB(t *testing.T) {\n\tif add(2, 3) != 5 { t.Errorf("no") }\n}\nfunc TestC(t *testing.T) {\n\tif add(-1, 1) != 0 { t.Errorf("no") }\n}';
    const after = 'func TestAdd(t *testing.T) {\n\tcases := []struct{ a, b, want int }{{1, 1, 2}, {2, 3, 5}, {-1, 1, 0}}\n\tfor _, tc := range cases {\n\t\tt.Run("case", func(t *testing.T) {\n\t\t\tif add(tc.a, tc.b) != tc.want { t.Errorf("no") }\n\t\t})\n\t}\n}';
    expect(blocking(modified('pkg/x_test.go', before, after))).toEqual([]);
    const helperBefore = 'func TestA(t *testing.T) {\n\tf, err := os.Open("a")\n\tif err != nil { t.Fatalf("open: %v", err) }\n\t_ = f\n}\nfunc TestB(t *testing.T) {\n\tf, err := os.Open("b")\n\tif err != nil { t.Fatalf("open: %v", err) }\n\t_ = f\n}';
    const helperAfter = 'func mustOpen(t *testing.T, p string) *os.File {\n\tt.Helper()\n\tf, err := os.Open(p)\n\tif err != nil { t.Fatalf("open: %v", err) }\n\treturn f\n}\nfunc TestA(t *testing.T) { _ = mustOpen(t, "a") }\nfunc TestB(t *testing.T) { _ = mustOpen(t, "b") }';
    expect(blocking(modified('pkg/x_test.go', helperBefore, helperAfter))).toEqual([]);
  });
});

describe('tampering is caught', () => {
  it('commented-out test body', () => {
    const before = "it('a', () => {\n  const r = calc(2, 3);\n  expect(r).toBe(5);\n});";
    const after = "it('a', () => {\n  // const r = calc(2, 3);\n  // expect(r).toBe(5);\n});";
    expect(medPlus(modified('tests/calc.test.ts', before, after))).toEqual(['assertions-removed']);
  });

  it('tautologies', () => {
    expect(medPlus(modified('tests/x.test.ts', "it('a', () => { expect(result).toEqual(expected); });", "it('a', () => { expect(true).toBe(true); });"))).toContain('tautology-added');
    expect(medPlus(modified('tests/test_x.py', 'def test_a():\n    assert x == 5', 'def test_a():\n    assert True'))).toContain('tautology-added');
    expect(medPlus(modified('pkg/x_test.go', 'func TestA(t *testing.T) {\n\tassert.Equal(t, 5, x)\n}', 'func TestA(t *testing.T) {\n\tassert.True(t, true)\n}'))).toContain('tautology-added');
  });

  it('early return before the assertions', () => {
    const before = "it('a', () => {\n  const r = calc(2, 3);\n  expect(r).toBe(5);\n});";
    const after = "it('a', () => {\n  const r = calc(2, 3);\n  return;\n  expect(r).toBe(5);\n});";
    expect(medPlus(modified('tests/calc.test.ts', before, after))).toEqual(['early-return-added']);
    const go = modified('pkg/x_test.go', 'func TestA(t *testing.T) {\n\tif x != 1 { t.Fatal("no") }\n}', 'func TestA(t *testing.T) {\n\tif os.Getenv("CI") != "" { return }\n\tif x != 1 { t.Fatal("no") }\n}');
    expect(medPlus(go)).toEqual(['early-return-added']);
    // a return at the end of a test is fine
    expect(scan(modified('tests/calc.test.ts', before, before.replace('});', '  return;\n});'))).findings).toEqual([]);
  });

  it('tolerance severity scales with the loss', () => {
    expect(medPlus(modified('tests/x.test.ts', 'expect(r).toBeCloseTo(0.3333, 4);', 'expect(r).toBeCloseTo(0.3333, 1);'))).toEqual(['tolerance-widened']);
    expect(scan(modified('tests/x.test.ts', 'expect(r).toBeCloseTo(0.3333, 4);', 'expect(r).toBeCloseTo(0.3333, 3);')).findings[0]?.severity).toBe('low');
    expect(scan(modified('tests/test_x.py', 'assert r == pytest.approx(expected(1, 3), rel=1e-6)', 'assert r == pytest.approx(expected(1, 3), rel=1e-1)')).findings[0]?.severity).toBe('high');
    expect(scan(modified('tests/test_x.py', 'self.assertAlmostEqual(f(1), g(2), places=7)', 'self.assertAlmostEqual(f(1), g(2), places=1)')).findings[0]?.severity).toBe('medium');
  });

  it('testify Equal -> NotNil / True is a downgrade', () => {
    expect(medPlus(modified('pkg/x_test.go', 'assert.Equal(t, 0, db.Count())', 'assert.NotNil(t, db.Count())'))).toEqual(['assertion-weakened']);
    expect(medPlus(modified('pkg/x_test.go', 'require.Equal(t, expected, got)', 'require.NotEmpty(t, got)'))).toEqual(['assertion-weakened']);
  });

  it('recover() in a Go test hides panics', () => {
    expect(medPlus(modified('pkg/x_test.go', 'func TestA(t *testing.T) {\n\trun(t)\n}', 'func TestA(t *testing.T) {\n\tdefer func() { recover() }()\n\trun(t)\n}'))).toEqual(['error-swallowed']);
  });
});

describe('configuration: precision', () => {
  it('forced exit status inside JSON strings and on non-test scripts', () => {
    expect(medPlus(modified('package.json', '  "test": "vitest run",', '  "test": "vitest run; exit 0",'))).toEqual(['config-weakened']);
    expect(medPlus(modified('package.json', '  "test": "vitest run",', '  "test": "vitest run; true",'))).toEqual(['config-weakened']);
    expect(scan(modified('package.json', '  "prepare": "husky install",', '  "prepare": "husky install || true",')).findings).toEqual([]);
    expect(scan(modified('Makefile', 'clean:\n\trm -rf dist', 'clean:\n\trm -rf dist || true')).findings).toEqual([]);
    expect(medPlus(modified('Makefile', 'test:\n\tgo test ./...', 'test:\n\tgo test ./... || true'))).toEqual(['config-weakened']);
  });

  it('CI: quoted if false, expression continue-on-error, comments, non-test steps', () => {
    expect(medPlus(modified('.github/workflows/ci.yml', '      - run: npm test', '      - run: npm test\n        if: "false"  # temporarily'))).toEqual(['config-weakened']);
    expect(medPlus(modified('.github/workflows/ci.yml', '      - run: npm test', '      - run: npm test\n        continue-on-error: ${{ true }}'))).toEqual(['config-weakened']);
    expect(scan(modified('.github/workflows/ci.yml', '      - run: npm test', '      # continue-on-error: true and || true are not allowed here\n      - run: npm test')).findings).toEqual([]);
    const upload = scan(modified('.github/workflows/ci.yml', '      - run: npm test\n      - uses: codecov/codecov-action@v4', '      - run: npm test\n      - name: coverage upload\n        uses: codecov/codecov-action@v4\n        continue-on-error: true'));
    expect(upload.blocking).toEqual([]);
  });

  it('replacing the test command with lint is a removed test step; a runner migration is not', () => {
    expect(medPlus(modified('.github/workflows/ci.yml', '      - run: npm test', '      - run: npm run lint'))).toEqual(['test-step-removed']);
    expect(scan(modified('package.json', '  "test": "mocha",', '  "test": "node --test",')).findings).toEqual([]);
  });

  it('narrowed test selection on the command line', () => {
    expect(medPlus(modified('package.json', '  "test": "jest",', '  "test": "jest --testPathPattern=smoke",'))).toEqual(['config-weakened']);
    expect(medPlus(modified('.github/workflows/ci.yml', '      - run: go test ./...', '      - run: go test -short -run TestSmoke ./...'))).toEqual(['config-weakened']);
    expect(medPlus(modified('.mocharc.yml', "spec: 'test/**/*.js'", "spec: 'test/one.js'"))).toEqual(['config-weakened']);
  });

  it('benign ignore lists and widened selections are quiet', () => {
    expect(scan(modified('jest.config.js', 'module.exports = {};', "module.exports = { testPathIgnorePatterns: ['/node_modules/', '/dist/'] };")).findings).toEqual([]);
    expect(scan(modified('vitest.config.ts', 'test: {}', "test: { exclude: ['node_modules', 'dist'] }")).findings).toEqual([]);
    expect(scan(modified('jest.config.js', "testMatch: ['**/*.test.ts'],", "testMatch: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],")).findings).toEqual([]);
    expect(medPlus(modified('jest.config.js', "testMatch: ['**/*.test.ts', '**/*.spec.ts'],", "testMatch: ['**/smoke.test.ts'],"))).toEqual(['config-weakened']);
    expect(scan(modified('pyproject.toml', 'addopts = "-q"', 'addopts = "-q -p no:cacheprovider"')).findings).toEqual([]);
    expect(medPlus(modified('pyproject.toml', 'addopts = "-q"', 'addopts = "-q -p no:cov --ignore=tests/slow"'))).toEqual(['config-weakened']);
  });
});
