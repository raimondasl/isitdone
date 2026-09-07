/**
 * Test-integrity scan: did the change weaken the tests that are about to be trusted?
 * Line/regex over diff hunks, no AST. Every detector is a heuristic with a severity tier; only
 * high/critical findings can block, and only in strict mode. Suppress a line with
 *   // isitdone: allow <reason>     # isitdone: allow <reason>
 * Suppressed findings are still reported, never hidden.
 */
import type { DiffFile, DiffLine } from './diff.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Lang = 'js' | 'py' | 'go' | 'other';

export interface Finding {
  id: string;
  severity: Severity;
  file: string;
  line: number | null;
  message: string;
  /** The offending line(s), trimmed. */
  evidence: string;
  /** Reason from an inline `isitdone: allow` comment, when present. */
  suppressed: string | null;
}

export interface IntegritySummary {
  testsBefore: number;
  testsAfter: number;
  assertionsBefore: number;
  assertionsAfter: number;
  skippedBefore: number;
  skippedAfter: number;
}

export interface IntegrityReport {
  findings: Finding[];
  summary: IntegritySummary;
  /** Number of changed files that were scanned. */
  files: number;
  /** Number of changed test files. */
  testFiles: number;
  /** Findings that would block in strict mode (unsuppressed high/critical). */
  blocking: Finding[];
}

export interface ScanOptions {
  /** Content of a file before the change (null if it did not exist). */
  readBefore: (path: string) => string | null;
  /** Content of a file after the change (null if deleted). */
  readAfter: (path: string) => string | null;
  /** Treat new suppressions as findings (CI mode). */
  ci?: boolean;
}

const SUPPRESS_RE = /isitdone:\s*allow(?:\s*[:\-]?\s*(.*?))?\s*(?:\*\/)?\s*$/i;

export function langOf(path: string): Lang {
  const p = path.toLowerCase();
  if (/\.(?:[cm]?[jt]sx?)$/.test(p)) return 'js';
  if (p.endsWith('.py')) return 'py';
  if (p.endsWith('.go')) return 'go';
  return 'other';
}

export function isTestFile(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop() ?? p;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/(^|\/)(?:__tests__|tests?|spec|specs|e2e|integration)\//.test(p) && langOf(p) !== 'other') return true;
  if (/^test_.*\.py$|_test\.py$|^tests?\.py$|^conftest\.py$/.test(base)) return true;
  if (/_test\.go$/.test(base)) return true;
  return false;
}

export function isTestConfigFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  const base = p.split('/').pop() ?? p;
  if (/^(?:jest|vitest|vite|playwright|cypress|karma|mocha|ava|wdio)\.config\.[cm]?[jt]s$/.test(base)) return true;
  if (/^\.mocharc/.test(base) || base === 'jest.config.json') return true;
  if (['package.json', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'Makefile', 'makefile', '.nycrc', 'codecov.yml', '.codecov.yml'].includes(base)) return true;
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) return true;
  if (/(^|\/)\.gitlab-ci\.ya?ml$/.test(p) || /(^|\/)\.circleci\/config\.ya?ml$/.test(p) || base === 'azure-pipelines.yml' || base === 'Jenkinsfile') return true;
  return false;
}

// --- counting -------------------------------------------------------------------------------------

const COUNTERS: Record<Exclude<Lang, 'other'>, { test: RegExp; assertion: RegExp; skip: RegExp }> = {
  js: {
    test: /\b(?:it|test|specify)(?:\.(?:each|concurrent|only|skip|todo|failing|sequential))*\s*(?:\(|`)/g,
    assertion: /\b(?:expect|assert(?:\.\w+)?|should|chai\.expect|t\.(?:equal|deepEqual|strictEqual|ok|is|true|false|throws|notThrows|not|match|snapshot|like|pass)|expectTypeOf)\s*\(/g,
    skip: /\b(?:it|test|describe|context|suite|specify)\.(?:skip|todo)\s*\(|\b(?:xit|xtest|xdescribe|xcontext|xspecify)\s*\(/g,
  },
  py: {
    test: /^\s*(?:async\s+)?def\s+test_?\w*\s*\(/gm,
    assertion: /^\s*assert\b|\bself\.assert\w+\s*\(|\bpytest\.raises\s*\(|\bassertpy\b|\bexpect\s*\(/gm,
    skip: /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(/g,
  },
  go: {
    test: /^func\s+(?:Test|Example|Benchmark|Fuzz)\w*\s*\(/gm,
    assertion: /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:assert|require)\.\w+\s*\(|\bis\.\w+\s*\(/g,
    skip: /\bt\.(?:Skip|SkipNow|Skipf)\s*\(|\btesting\.Short\s*\(/g,
  },
};

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

export function countTests(lang: Lang, text: string | null): { tests: number; assertions: number; skipped: number } {
  if (!text || lang === 'other') return { tests: 0, assertions: 0, skipped: 0 };
  const c = COUNTERS[lang];
  return { tests: count(c.test, text), assertions: count(c.assertion, text), skipped: count(c.skip, text) };
}

// --- helpers --------------------------------------------------------------------------------------

function suppression(lines: DiffLine[], idx: number): string | null {
  const here = lines[idx];
  if (!here) return null;
  const m = SUPPRESS_RE.exec(here.text);
  if (m) return (m[1] ?? '').trim() || 'no reason given';
  const prev = lines[idx - 1];
  if (prev && prev.kind !== '-') {
    const pm = SUPPRESS_RE.exec(prev.text);
    if (pm && /^\s*(?:\/\/|#|\/\*|--|<!--)/.test(prev.text)) return (pm[1] ?? '').trim() || 'no reason given';
  }
  return null;
}

/** Blank the contents of string literals so `it.only(` inside a string (e.g. a test of a linter) is not a call. */
function stripStrings(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[m.length - 1]);
}

/** Comments removed, strings intact: for comparing lines. */
function stripComment(lang: Lang, text: string): string {
  if (lang === 'py') return text.replace(/#.*$/, '');
  return text.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

/** Comments removed and strings blanked: for pattern matching. */
function normalize(lang: Lang, text: string): string {
  return stripComment(lang, stripStrings(text));
}

function trimEvidence(s: string): string {
  const t = s.trim();
  return t.length > 160 ? t.slice(0, 157) + '...' : t;
}

interface Ctx {
  file: DiffFile;
  lang: Lang;
  findings: Finding[];
  ci: boolean;
}

function add(ctx: Ctx, id: string, severity: Severity, line: DiffLine | null, message: string, evidence: string, suppressed: string | null): void {
  ctx.findings.push({ id, severity, file: ctx.file.path, line: line ? (line.newNo ?? line.oldNo) : null, message, evidence: trimEvidence(evidence), suppressed });
  if (suppressed && ctx.ci) {
    ctx.findings.push({ id: 'suppression-added', severity: 'high', file: ctx.file.path, line: line ? (line.newNo ?? line.oldNo) : null, message: `suppression added in CI mode (${suppressed})`, evidence: trimEvidence(evidence), suppressed: null });
  }
}

// --- detectors over test files --------------------------------------------------------------------

const JS_ONLY = /\b(?:it|test|describe|context|suite)\.only\s*\(|\b(?:fit|fdescribe|ftest)\s*\(/;

const DOWNGRADES: Array<{ from: RegExp; to: RegExp; what: string }> = [
  { from: /\.toStrictEqual\s*\(/, to: /\.toEqual\s*\(/, what: 'toStrictEqual -> toEqual' },
  { from: /\.toEqual\s*\(/, to: /\.(?:toBeTruthy|toBeDefined|toBeTruthy|not\.toBeNull|not\.toBeUndefined)\s*\(/, what: 'toEqual -> existence check' },
  { from: /\.toBe\s*\((?!true|false)/, to: /\.(?:toBeTruthy|toBeDefined|not\.toBeNull|not\.toBeUndefined|toBeFalsy)\s*\(/, what: 'toBe(value) -> truthiness check' },
  { from: /\.toHaveBeenCalledWith\s*\(/, to: /\.toHaveBeenCalled\s*\(\s*\)/, what: 'toHaveBeenCalledWith -> toHaveBeenCalled' },
  { from: /\.toHaveBeenCalledTimes\s*\(/, to: /\.toHaveBeenCalled\s*\(\s*\)/, what: 'toHaveBeenCalledTimes -> toHaveBeenCalled' },
  { from: /\.toThrow(?:Error)?\s*\(\s*(?:['"`\/]|new\s|\w)/, to: /\.toThrow(?:Error)?\s*\(\s*\)/, what: 'toThrow(message) -> toThrow()' },
  { from: /\.toHaveLength\s*\(\s*\d+/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: 'toHaveLength(n) -> existence check' },
  { from: /\.toMatchObject\s*\(/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: 'toMatchObject -> existence check' },
  { from: /\.toMatchSnapshot\s*\(|\.toMatchInlineSnapshot\s*\(/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: 'snapshot -> existence check' },
  { from: /\bassertEqual\s*\(/, to: /\bassert(?:True|IsNotNone|In)\s*\(/, what: 'assertEqual -> weaker assert' },
  { from: /\bassertRaises\s*\(\s*\w+/, to: /\bassertRaises\s*\(\s*Exception\b/, what: 'assertRaises(Specific) -> assertRaises(Exception)' },
  { from: /\bpytest\.raises\s*\(\s*(?!Exception\b)\w+/, to: /\bpytest\.raises\s*\(\s*(?:Exception|BaseException)\b/, what: 'pytest.raises(Specific) -> raises(Exception)' },
  { from: /\b(?:assert|require)\.(?:Equal|EqualValues|Exactly|Same|ElementsMatch|Len)\s*\(/, to: /\b(?:assert|require)\.(?:NotNil|NotEmpty|True|NoError)\s*\(/, what: 'Equal -> NotNil/NotEmpty/True' },
];

function subjectOf(text: string): string {
  // the part before the matcher: expect(x) / assert.X( / self.assertX( / pytest.raises(
  const m = /^(.*?)\.(?:to[A-Z]\w*|not)\b/.exec(text) ?? /^(.*?)\b(?:pytest\.raises|assertRaises)\s*\(/.exec(text) ?? /^(.*?)\b(?:assert\w*|require\.\w+)\s*\(/.exec(text);
  return (m?.[1] ?? text).replace(/\s+/g, '').slice(-60);
}

function scanTestFile(ctx: Ctx, opts: ScanOptions): void {
  const { file, lang } = ctx;
  if (file.status === 'deleted') {
    add(ctx, 'test-file-deleted', 'high', null, 'test file deleted', file.path, null);
    return;
  }
  const before = countTests(lang, file.status === 'added' ? null : opts.readBefore(file.oldPath ?? file.path));
  const after = countTests(lang, opts.readAfter(file.path));

  for (const hunk of file.hunks) {
    const removed = hunk.lines.filter((l) => l.kind === '-');
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i] as DiffLine;
      if (line.kind !== '+') continue;
      const code = normalize(lang, line.text);
      const sup = suppression(hunk.lines, i);

      if (lang === 'js' && JS_ONLY.test(code)) add(ctx, 'only-added', 'critical', line, '`.only` added: every other test in the file is silently skipped', line.text, sup);

      const skipRe = lang === 'other' ? null : COUNTERS[lang].skip;
      if (skipRe && count(skipRe, code) > 0) {
        // A skip that merely moved (identical line removed elsewhere in the hunk) is not new.
        const moved = removed.some((r) => stripComment(lang, r.text).trim() === stripComment(lang, line.text).trim());
        if (!moved) add(ctx, 'skip-added', 'high', line, 'test skipped or marked expected-failure', line.text, sup);
      }

      for (const d of DOWNGRADES) {
        if (!d.to.test(code)) continue;
        const subj = subjectOf(code);
        const strong = removed.find((r) => d.from.test(normalize(lang, r.text)) && subjectOf(normalize(lang, r.text)) === subj);
        if (strong) add(ctx, 'assertion-weakened', 'medium', line, `assertion weakened: ${d.what}`, `- ${strong.text.trim()}\n+ ${line.text.trim()}`, sup);
      }

      const closeTo = /\.toBeCloseTo\s*\([^,)]+,\s*(\d+)\s*\)/.exec(code);
      if (closeTo) {
        const prev = removed.map((r) => /\.toBeCloseTo\s*\([^,)]+,\s*(\d+)\s*\)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(closeTo[1]) < Number(prev[1])) add(ctx, 'tolerance-widened', 'low', line, `toBeCloseTo precision lowered ${prev[1]} -> ${closeTo[1]}`, line.text, sup);
      }
      const approx = /pytest\.approx\s*\([^)]*?(?:rel|abs)\s*=\s*([\d.eE-]+)/.exec(code);
      if (approx) {
        const prev = removed.map((r) => /pytest\.approx\s*\([^)]*?(?:rel|abs)\s*=\s*([\d.eE-]+)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(approx[1]) > Number(prev[1])) add(ctx, 'tolerance-widened', 'low', line, `pytest.approx tolerance widened ${prev[1]} -> ${approx[1]}`, line.text, sup);
      }
      const places = /assertAlmostEqual\s*\([^)]*?places\s*=\s*(\d+)/.exec(code);
      if (places) {
        const prev = removed.map((r) => /assertAlmostEqual\s*\([^)]*?places\s*=\s*(\d+)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(places[1]) < Number(prev[1])) add(ctx, 'tolerance-widened', 'low', line, `assertAlmostEqual places lowered ${prev[1]} -> ${places[1]}`, line.text, sup);
      }

      // Swallowed errors: an added catch/except with an empty body.
      if (lang === 'js' && /\bcatch\b/.test(code)) {
        const body = hunk.lines.slice(i + 1, i + 4).filter((l) => l.kind === '+').map((l) => normalize('js', l.text).trim());
        if (/\bcatch\b[^{]*\{\s*\}\s*$/.test(code) || (body.length > 0 && body[0] === '}')) add(ctx, 'error-swallowed', 'medium', line, 'empty catch block added in a test', line.text, sup);
      }
      if (lang === 'py' && /^\s*except\b[^:]*:\s*(?:pass|\.\.\.)?\s*$/.test(code)) {
        const next = hunk.lines.slice(i + 1, i + 3).filter((l) => l.kind === '+').map((l) => normalize('py', l.text).trim())[0];
        if (/^\s*except\b[^:]*:\s*(?:pass|\.\.\.)\s*$/.test(code) || next === 'pass' || next === '...') add(ctx, 'error-swallowed', 'medium', line, 'except ... pass added in a test', line.text, sup);
      }
    }
  }

  if (file.status !== 'added') {
    const dropped = before.tests - after.tests;
    if (dropped > 0) add(ctx, 'tests-removed', dropped >= 2 ? 'high' : 'medium', null, `test count dropped ${before.tests} -> ${after.tests}`, `${file.path}: ${dropped} test${dropped === 1 ? '' : 's'} removed`, null);
    const lost = before.assertions - after.assertions;
    if (lost > 0 && after.tests >= before.tests) {
      const sev: Severity = lost >= 3 || lost / Math.max(1, before.assertions) > 0.3 ? 'high' : 'medium';
      add(ctx, 'assertions-removed', sev, null, `assertion count dropped ${before.assertions} -> ${after.assertions} with no test removed`, `${file.path}: ${lost} assertion${lost === 1 ? '' : 's'} removed`, null);
    }
  }
}

// --- detectors over config / CI files --------------------------------------------------------------

const CONFIG_SABOTAGE: Array<{ re: RegExp; severity: Severity; message: string; only?: RegExp }> = [
  { re: /testPathIgnorePatterns|testIgnore|ignorePatterns\s*[:=]|modulePathIgnorePatterns/, severity: 'critical', message: 'test ignore pattern added' },
  { re: /\b(?:testMatch|testRegex|include)\s*[:=]/, severity: 'high', message: 'test file selection narrowed or changed', only: /(?:jest|vitest|vite|playwright|cypress|karma|mocha|ava)\.config|\.mocharc|jest\.config\.json/ },
  { re: /\bexclude\s*[:=]\s*\[/, severity: 'high', message: 'test exclude list changed', only: /(?:vitest|vite|playwright)\.config/ },
  { re: /--passWithNoTests|passWithNoTests\s*[:=]\s*true/, severity: 'critical', message: 'passWithNoTests: a suite with zero tests is reported green' },
  { re: /\|\|\s*true\b|\|\|\s*exit\s+0\b|;\s*true\s*$|;\s*exit\s+0\s*$/, severity: 'critical', message: 'exit status forced to success' },
  { re: /continue-on-error\s*:\s*true/, severity: 'critical', message: 'CI step failures ignored (continue-on-error)' },
  { re: /^\s*if\s*:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/, severity: 'critical', message: 'CI step disabled with if: false' },
  { re: /--no-verify\b|--no-gpg-sign\b/, severity: 'high', message: 'git hooks bypassed (--no-verify)' },
  { re: /\bpytest\b.*(?:-p\s+no:|--ignore[=\s]|--deselect[=\s]|-k\s+["']?not\b)|addopts\s*=.*(?:-p\s+no:|--ignore|--deselect|-k\s+["']?not\b)/, severity: 'high', message: 'pytest collection narrowed (ignore/deselect/-k not/-p no:)' },
  { re: /\b(?:norecursedirs|python_files|testpaths)\s*=/, severity: 'medium', message: 'pytest discovery configuration changed' },
  { re: /"test"\s*:\s*"(?:echo\b|true\b|exit 0\b|:\s*"|npm run test:unit -- --testPathPattern)/, severity: 'critical', message: 'test script neutered' },
  { re: /--updateSnapshot\b|\s-u\b.*(?:jest|vitest)|(?:jest|vitest).*\s-u\b|\bupdateSnapshot\s*[:=]\s*true|SNAPSHOT_UPDATE|--update-snapshots\b/, severity: 'medium', message: 'snapshots updated automatically' },
  { re: /\bskipLibCheck\b|\bnoEmitOnError\s*:\s*false/, severity: 'low', message: 'type checking relaxed' },
  { re: /\btimeout\s*[:=]\s*\d{6,}/, severity: 'low', message: 'very large timeout added' },
];

const TEST_STEP = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|typecheck|lint|check)\b|\b(?:vitest|jest|mocha|pytest|go\s+test|cargo\s+test|dotnet\s+test|make\s+(?:test|check)|tox|nox)\b/;

function scanConfigFile(ctx: Ctx): void {
  const { file } = ctx;
  const isWorkflow = /(^|\/)\.github\/workflows\//.test(file.path.replace(/\\/g, '/'));
  if (file.status === 'deleted' && isWorkflow) {
    add(ctx, 'ci-workflow-deleted', 'high', null, 'CI workflow deleted', file.path, null);
    return;
  }
  for (const hunk of file.hunks) {
    const addedText = hunk.lines.filter((l) => l.kind === '+').map((l) => l.text).join('\n');
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i] as DiffLine;
      if (line.kind === '-') {
        if (TEST_STEP.test(line.text) && !TEST_STEP.test(addedText)) {
          add(ctx, 'test-step-removed', 'high', line, 'a test/lint/typecheck command was removed from configuration', line.text, null);
        }
        continue;
      }
      if (line.kind !== '+') continue;
      const sup = suppression(hunk.lines, i);
      for (const rule of CONFIG_SABOTAGE) {
        if (rule.only && !rule.only.test(file.path)) continue;
        if (rule.re.test(line.text)) {
          // "|| true" and friends only matter in scripts/commands, not in prose.
          add(ctx, 'config-weakened', rule.severity, line, rule.message, line.text, sup);
          break;
        }
      }
    }
  }
}

// --- entry point ----------------------------------------------------------------------------------

export function scanIntegrity(files: DiffFile[], opts: ScanOptions): IntegrityReport {
  const findings: Finding[] = [];
  const summary: IntegritySummary = { testsBefore: 0, testsAfter: 0, assertionsBefore: 0, assertionsAfter: 0, skippedBefore: 0, skippedAfter: 0 };
  let testFiles = 0;
  for (const file of files) {
    if (file.binary) continue;
    const lang = langOf(file.path);
    const ctx: Ctx = { file, lang, findings, ci: opts.ci ?? false };
    if (isTestFile(file.path) || (file.oldPath && isTestFile(file.oldPath))) {
      testFiles++;
      const before = countTests(lang, file.status === 'added' ? null : opts.readBefore(file.oldPath ?? file.path));
      const after = countTests(lang, file.status === 'deleted' ? null : opts.readAfter(file.path));
      summary.testsBefore += before.tests;
      summary.testsAfter += after.tests;
      summary.assertionsBefore += before.assertions;
      summary.assertionsAfter += after.assertions;
      summary.skippedBefore += before.skipped;
      summary.skippedAfter += after.skipped;
      scanTestFile(ctx, opts);
    }
    if (isTestConfigFile(file.path)) scanConfigFile(ctx);
    if (/\.snap$/.test(file.path) && file.status !== 'added') {
      add(ctx, 'snapshot-changed', 'low', null, 'snapshot file changed', file.path, null);
    }
  }
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const blocking = findings.filter((f) => !f.suppressed && (f.severity === 'critical' || f.severity === 'high'));
  return { findings, summary, files: files.length, testFiles, blocking };
}

export function formatSummaryLine(s: IntegritySummary): string {
  return `Tests ${s.testsBefore} -> ${s.testsAfter}   Assertions ${s.assertionsBefore} -> ${s.assertionsAfter}   Skipped ${s.skippedBefore} -> ${s.skippedAfter}`;
}
