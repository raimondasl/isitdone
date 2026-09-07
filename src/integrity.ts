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

// --- text normalisation ---------------------------------------------------------------------------

/** Blank the contents of string literals so `it.only(` inside a string (e.g. a test of a linter) is not a call. */
function stripStrings(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[m.length - 1]);
}

/** Comments removed, strings intact: for comparing lines. */
function stripComment(lang: Lang, text: string): string {
  if (lang === 'py') return text.replace(/#.*$/, '');
  return text.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

/** Comments removed and strings blanked: for pattern matching on one line. */
function normalize(lang: Lang, text: string): string {
  return stripComment(lang, stripStrings(text));
}

/** Whole-file normalisation for counting: strings blanked, comments blanked. Length-preserving, so offsets line up with the original. */
export function normalizeFile(lang: Lang, text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  let out = text.split('\n').map((l) => stripStrings(l)).join('\n');
  if (lang === 'py') {
    out = out.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, blank);
    out = out.replace(/#.*$/gm, blank);
  } else {
    out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
    out = out.replace(/\/\/.*$/gm, blank);
  }
  return out;
}

/**
 * Which hunk lines (by index) are entirely inside a multi-line block comment or docstring.
 * Removed lines are ignored for state; the hunk is walked in order as the new file reads.
 */
function insideBlockComment(lang: Lang, lines: DiffLine[]): boolean[] {
  const out: boolean[] = [];
  let open = false;
  for (const l of lines) {
    if (l.kind === '-') {
      out.push(false);
      continue;
    }
    const startsInside = open;
    let rest = lang === 'py' ? l.text : stripStrings(l.text);
    let codeOutside = false;
    // Walk the line token by token, toggling comment state.
    for (;;) {
      if (open) {
        const close = lang === 'py' ? firstOf(rest, ['"""', "'''"]) : rest.indexOf('*/');
        if (close < 0) {
          rest = '';
          break;
        }
        rest = rest.slice(close + (lang === 'py' ? 3 : 2));
        open = false;
      } else {
        const start = lang === 'py' ? firstOf(rest, ['"""', "'''"]) : rest.indexOf('/*');
        if (start < 0) {
          if (rest.trim() !== '') codeOutside = true;
          break;
        }
        if (rest.slice(0, start).trim() !== '') codeOutside = true;
        rest = rest.slice(start + (lang === 'py' ? 3 : 2));
        open = true;
      }
    }
    out.push(startsInside && !codeOutside);
  }
  return out;
}

function firstOf(text: string, tokens: string[]): number {
  let best = -1;
  for (const t of tokens) {
    const i = text.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

// --- counting -------------------------------------------------------------------------------------

const COUNTERS: Record<Exclude<Lang, 'other'>, { test: RegExp; assertion: RegExp; skip: RegExp }> = {
  js: {
    test: /\b(?:it|test|specify)(?:\.(?:each|concurrent|only|skip|failing|sequential))*\s*(?:\(|`)/g,
    assertion: /\b(?:expect|assert(?:\.\w+)?|should|chai\.expect|t\.(?:equal|deepEqual|strictEqual|ok|is|true|false|throws|notThrows|not|match|snapshot|like|pass)|expectTypeOf)\s*\(/g,
    skip: /\b(?:it|test|describe|context|suite|specify)\.skip\s*\(|\b(?:xit|xtest|xdescribe|xcontext|xspecify)\s*\(/g,
  },
  py: {
    test: /^\s*(?:async\s+)?def\s+test[\p{L}\p{N}_]*\s*\(/gmu,
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

const EACH_CALL = /\b(?:it|test|specify|describe)(?:\.(?:concurrent|only|skip|failing|sequential))*\.each\s*(\(|`)/g;

/** Rows in an it.each / test.each table (array literal or tagged template) and where the table ends. */
function eachRows(text: string, afterMatch: number, opener: string): { rows: number; end: number } {
  if (opener === '`') {
    const end = text.indexOf('`', afterMatch);
    if (end < 0) return { rows: 1, end: afterMatch };
    const rows = text.slice(afterMatch, end).split('\n').map((r) => r.trim()).filter((r) => r.includes('|'));
    return { rows: Math.max(1, rows.length - 1), end: end + 1 }; // first row is the header
  }
  let i = afterMatch;
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  if (text[i] !== '[') return { rows: 1, end: afterMatch };
  let depth = 0;
  let rows = 0;
  let sawElement = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
      if (depth === 2 && ch !== '(') sawElement = true;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
      if (depth === 0) {
        if (sawElement) rows++;
        return { rows: Math.max(1, rows), end: j + 1 };
      }
    } else if (ch === ',' && depth === 1) {
      if (sawElement) rows++;
      sawElement = false;
    } else if (depth === 1 && !/\s/.test(ch as string)) {
      sawElement = true;
    }
  }
  return { rows: 1, end: afterMatch };
}

/** The text of the call that follows a table: `it.each([...])(<here>)`. Empty if it cannot be found. */
function eachBody(text: string, from: number): string {
  const open = text.indexOf('(', from);
  if (open < 0 || open - from > 40) return '';
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const ch = text[j];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open, j + 1);
    }
  }
  return '';
}

export interface TestCounts {
  tests: number;
  assertions: number;
  skipped: number;
  /** An it.each/describe.each whose row count could not be read from a literal table. */
  unknownEach: boolean;
}

export function countTests(lang: Lang, text: string | null): TestCounts {
  if (!text || lang === 'other') return { tests: 0, assertions: 0, skipped: 0, unknownEach: false };
  const c = COUNTERS[lang];
  const norm = normalizeFile(lang, text);
  let tests = count(c.test, norm);
  let assertions = count(c.assertion, norm);
  let unknownEach = false;
  if (lang === 'js') {
    // Credit table rows: it.each([...3 rows...]) is three tests, and its assertions run three times.
    EACH_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EACH_CALL.exec(norm))) {
      const opener = m[1] as string;
      const afterMatch = m.index + m[0].length;
      const literal = opener === '`' || /^\s*\[/.test(norm.slice(afterMatch, afterMatch + 20));
      if (m[0].startsWith('describe') || !literal) {
        unknownEach = true; // rows multiply inner tests, or the table is a variable
        continue;
      }
      const { rows, end } = eachRows(opener === '`' ? text : norm, afterMatch, opener);
      tests += rows - 1;
      assertions += (rows - 1) * count(c.assertion, eachBody(norm, end));
    }
  }
  if (lang === 'go') tests += count(/\bt\.Run\s*\(/g, norm);
  return { tests, assertions, skipped: count(c.skip, norm), unknownEach };
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

function trimEvidence(s: string): string {
  const t = s.trim();
  return t.length > 160 ? t.slice(0, 157) + '...' : t;
}

function indentOf(text: string): number {
  return /^\s*/.exec(text)?.[0].length ?? 0;
}

function titleOf(text: string): string | null {
  const m = /['"`]([^'"`]{1,200})['"`]/.exec(text);
  return m ? (m[1] as string) : null;
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
const JS_TODO = /\b(?:it|test|specify)\.todo\s*\(/;
const STRONG_MATCHER = /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toContainEqual|toHaveProperty|toMatch|toThrow|toHaveBeenCalledWith|toHaveBeenCalledTimes|toBeCloseTo|toBeGreaterThan|toBeLessThan|toMatchSnapshot|toMatchInlineSnapshot)\s*\(/;
const LOOP_ONLY = /\bfor\s*\(|\.forEach\s*\(|\.map\s*\(|\bwhile\s*\(|@pytest\.mark\.parametrize|^\s*for\s+[\p{L}\p{N}_,\s]+\s+in\b|\bt\.Run\s*\(|\brange\s+\w+/mu;
const TAUTOLOGY = {
  js: /\bexpect\s*\(\s*(?:true|false|null|undefined|\d+|'\s*'|"\s*"|`\s*`)\s*\)\s*\.(?:not\.)?(?:toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy|toBeDefined|toBeNull|toBeUndefined)\s*\(/,
  py: /^\s*assert\s+(?:True|1|"\s*"|'\s*')\s*(?:#.*)?$|\bself\.assertTrue\s*\(\s*True\s*\)|\bself\.assertEqual\s*\(\s*(\w+)\s*,\s*\1\s*\)/,
  go: /\b(?:assert|require)\.True\s*\(\s*t\s*,\s*true\s*\)|\b(?:assert|require)\.Equal\s*\(\s*t\s*,\s*(\w+)\s*,\s*\1\s*\)/,
};
const EARLY_RETURN = /^\s*(?:if\b[^{]*\{\s*)?return;?\s*\}?\s*$/;

const DOWNGRADES: Array<{ from: RegExp; to: RegExp; what: string; existence?: boolean }> = [
  { from: /\.toStrictEqual\s*\(/, to: /\.toEqual\s*\(/, what: 'toStrictEqual -> toEqual' },
  { from: /\.toEqual\s*\(/, to: /\.(?:toBeTruthy|toBeDefined|not\.toBeNull|not\.toBeUndefined)\s*\(/, what: 'toEqual -> existence check', existence: true },
  { from: /\.toBe\s*\((?!true|false)/, to: /\.(?:toBeTruthy|toBeDefined|not\.toBeNull|not\.toBeUndefined|toBeFalsy)\s*\(/, what: 'toBe(value) -> truthiness check', existence: true },
  { from: /\.toHaveBeenCalledWith\s*\(/, to: /\.toHaveBeenCalled\s*\(\s*\)/, what: 'toHaveBeenCalledWith -> toHaveBeenCalled' },
  { from: /\.toHaveBeenCalledTimes\s*\(/, to: /\.toHaveBeenCalled\s*\(\s*\)/, what: 'toHaveBeenCalledTimes -> toHaveBeenCalled' },
  { from: /\.toThrow(?:Error)?\s*\(\s*(?:['"`\/]|new\s|\w)/, to: /\.toThrow(?:Error)?\s*\(\s*\)/, what: 'toThrow(message) -> toThrow()' },
  { from: /\.toHaveLength\s*\(\s*\d+/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: 'toHaveLength(n) -> existence check', existence: true },
  { from: /\.toMatchObject\s*\(/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: 'toMatchObject -> existence check', existence: true },
  { from: /\.toMatchSnapshot\s*\(|\.toMatchInlineSnapshot\s*\(/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: 'snapshot -> existence check', existence: true },
  { from: /\bassertEqual\s*\(/, to: /\bassert(?:True|IsNotNone|In)\s*\(/, what: 'assertEqual -> weaker assert' },
  { from: /\bassertRaises\s*\(\s*\w+/, to: /\bassertRaises\s*\(\s*Exception\b/, what: 'assertRaises(Specific) -> assertRaises(Exception)' },
  { from: /\bpytest\.raises\s*\(\s*(?!Exception\b)\w+/, to: /\bpytest\.raises\s*\(\s*(?:Exception|BaseException)\b/, what: 'pytest.raises(Specific) -> raises(Exception)' },
  { from: /\b(?:assert|require)\.(?:Equal|EqualValues|Exactly|Same|ElementsMatch|Len)\s*\(/, to: /\b(?:assert|require)\.(?:NotNil|NotEmpty|True|NoError)\s*\(/, what: 'Equal -> NotNil/NotEmpty/True' },
];

/** The value under test: `expect(x)` prefix, `self.assertX(` prefix, or for testify the last argument. */
function subjectOf(lang: Lang, text: string): string {
  if (lang === 'go') {
    const m = /\b(?:assert|require)\.\w+\s*\(([\s\S]*)\)\s*$/.exec(text.trim());
    if (m) {
      const args = splitTopLevel(m[1] as string);
      return (args[args.length - 1] ?? '').replace(/\s+/g, '').slice(-60);
    }
  }
  const m = /^(.*?)\.(?:to[A-Z]\w*|not)\b/.exec(text) ?? /^(.*?)\b(?:pytest\.raises|assertRaises)\s*\(/.exec(text) ?? /^(.*?)\b(?:assert\w*|require\.\w+)\s*\(/.exec(text);
  return (m?.[1] ?? text).replace(/\s+/g, '').slice(-60);
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

/** `expect(cfg.name)` and `expect(cfg)` share the root `expect(cfg`. */
function subjectRoot(subject: string): string {
  const m = /^(expect\([^.)\[]*)/.exec(subject);
  return m ? (m[1] as string) : subject;
}

function toleranceSeverity(kind: 'digits' | 'factor', before: number, after: number): Severity {
  if (kind === 'digits') {
    if (after <= 0) return 'high';
    return before - after >= 2 ? 'medium' : 'low';
  }
  const factor = after / Math.max(before, 1e-300);
  return factor >= 100 ? 'high' : factor >= 10 ? 'medium' : 'low';
}

interface CrossFile {
  /** Test-declaration lines added per file (normalised), with multiplicity; a move is a match in ANOTHER file. */
  addedByFile: Map<string, Map<string, number>>;
}

function takeMoved(cross: CrossFile, fromPath: string, decl: string): boolean {
  for (const [path, titles] of cross.addedByFile) {
    if (path === fromPath) continue;
    const n = titles.get(decl) ?? 0;
    if (n > 0) {
      titles.set(decl, n - 1);
      return true;
    }
  }
  return false;
}

function declarationLines(lang: Lang, lines: DiffLine[], kind: '+' | '-'): string[] {
  if (lang === 'other') return [];
  const re = new RegExp(COUNTERS[lang].test.source, COUNTERS[lang].test.flags.replace('g', ''));
  return lines.filter((l) => l.kind === kind).map((l) => normalize(lang, l.text).trim()).filter((t) => re.test(t) && !/\.skip\s*\(|\.only\s*\(/.test(t));
}

function scanTestFile(ctx: Ctx, opts: ScanOptions, cross: CrossFile, movedPair: boolean): void {
  const { file, lang } = ctx;
  if (file.status === 'deleted') {
    if (!movedPair) add(ctx, 'test-file-deleted', 'high', null, 'test file deleted', file.path, null);
    return;
  }
  if (file.oldPath && isTestFile(file.oldPath) && !isTestFile(file.path)) {
    add(ctx, 'test-file-deleted', 'high', null, `test file moved out of the test locations (${file.oldPath} -> ${file.path}); the runner will no longer collect it`, file.path, null);
    return;
  }
  const beforeText = file.status === 'added' ? null : opts.readBefore(file.oldPath ?? file.path);
  const afterText = opts.readAfter(file.path);
  const before = countTests(lang, beforeText);
  const after = countTests(lang, afterText);
  const allRemoved = file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === '-'));
  const allAdded = file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === '+'));
  const addedNorm = allAdded.map((l) => normalize(lang, l.text));
  const addedText = addedNorm.join('\n');

  for (const hunk of file.hunks) {
    const removed = hunk.lines.filter((l) => l.kind === '-');
    const added = hunk.lines.filter((l) => l.kind === '+');
    const inComment = insideBlockComment(lang, hunk.lines);
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i] as DiffLine;
      if (line.kind !== '+') continue;
      if (inComment[i]) continue;
      const code = normalize(lang, line.text);
      if (code.trim() === '') continue;
      const sup = suppression(hunk.lines, i);

      if (lang === 'js' && JS_ONLY.test(code)) add(ctx, 'only-added', 'critical', line, '`.only` added: every other test in the file is silently skipped', line.text, sup);

      const skipRe = lang === 'other' ? null : COUNTERS[lang].skip;
      if (skipRe && count(skipRe, code) > 0) {
        // A skip that merely moved (identical line removed anywhere in the file) is not new.
        const moved = allRemoved.some((r) => stripComment(lang, r.text).trim() === stripComment(lang, line.text).trim());
        if (!moved) add(ctx, 'skip-added', 'high', line, 'test skipped or marked expected-failure', line.text, sup);
      }
      if (lang === 'js' && JS_TODO.test(code)) {
        const title = titleOf(line.text);
        const wasReal = title !== null && removed.some((r) => /\b(?:it|test|specify)\s*\(/.test(normalize('js', r.text)) && titleOf(r.text) === title);
        if (wasReal) add(ctx, 'skip-added', 'high', line, 'existing test turned into a todo placeholder', line.text, sup);
        else add(ctx, 'todo-added', 'low', line, 'todo placeholder added (not a real test)', line.text, sup);
      }

      const taut = lang === 'other' ? null : TAUTOLOGY[lang];
      if (taut && taut.test(code)) add(ctx, 'tautology-added', 'high', line, 'assertion that can never fail', line.text, sup);

      if (EARLY_RETURN.test(code)) {
        const indent = indentOf(line.text);
        const assertRe = lang === 'other' ? null : COUNTERS[lang].assertion;
        let shadowed = false;
        for (let j = i + 1; j < Math.min(hunk.lines.length, i + 20); j++) {
          const next = hunk.lines[j] as DiffLine;
          if (next.kind === '-') continue;
          const t = normalize(lang, next.text);
          if (t.trim() === '') continue;
          if (indentOf(next.text) < indent || (lang !== 'py' && /^\s*\}/.test(t) && indentOf(next.text) <= indent)) break;
          if (assertRe && count(assertRe, t) > 0) {
            shadowed = true;
            break;
          }
        }
        if (shadowed) add(ctx, 'early-return-added', 'high', line, 'return added before the assertions; the rest of the test never runs', line.text, sup);
      }

      for (const d of DOWNGRADES) {
        if (!d.to.test(code)) continue;
        const subj = subjectOf(lang, code);
        const strong = removed.find((r) => d.from.test(normalize(lang, r.text)) && subjectOf(lang, normalize(lang, r.text)) === subj);
        if (!strong) continue;
        // The strong assertion is still there (re-indented / reformatted): not a downgrade.
        if (added.some((a) => a !== line && d.from.test(normalize(lang, a.text)) && subjectOf(lang, normalize(lang, a.text)) === subj)) continue;
        // Existence check next to stronger assertions on the same value (snapshot -> explicit fields): not a downgrade.
        if (d.existence) {
          const root = subjectRoot(subj);
          const stronger = added.filter((a) => a !== line && STRONG_MATCHER.test(normalize(lang, a.text)) && subjectRoot(subjectOf(lang, normalize(lang, a.text))) === root);
          if (stronger.length > 0) continue;
        }
        add(ctx, 'assertion-weakened', 'medium', line, `assertion weakened: ${d.what}`, `- ${strong.text.trim()}\n+ ${line.text.trim()}`, sup);
      }

      const closeTo = /\.toBeCloseTo\s*\([^,)]+,\s*(\d+)\s*\)/.exec(code);
      if (closeTo) {
        const prev = removed.map((r) => /\.toBeCloseTo\s*\([^,)]+,\s*(\d+)\s*\)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(closeTo[1]) < Number(prev[1])) add(ctx, 'tolerance-widened', toleranceSeverity('digits', Number(prev[1]), Number(closeTo[1])), line, `toBeCloseTo precision lowered ${prev[1]} -> ${closeTo[1]}`, line.text, sup);
      }
      const approx = /pytest\.approx\s*\(.*?(?:rel|abs)\s*=\s*([\d.eE+-]+)/.exec(code);
      if (approx) {
        const prev = removed.map((r) => /pytest\.approx\s*\(.*?(?:rel|abs)\s*=\s*([\d.eE+-]+)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(approx[1]) > Number(prev[1])) add(ctx, 'tolerance-widened', toleranceSeverity('factor', Number(prev[1]), Number(approx[1])), line, `pytest.approx tolerance widened ${prev[1]} -> ${approx[1]}`, line.text, sup);
      }
      const places = /assertAlmostEqual\s*\(.*?places\s*=\s*(\d+)/.exec(code);
      if (places) {
        const prev = removed.map((r) => /assertAlmostEqual\s*\(.*?places\s*=\s*(\d+)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(places[1]) < Number(prev[1])) add(ctx, 'tolerance-widened', toleranceSeverity('digits', Number(prev[1]), Number(places[1])), line, `assertAlmostEqual places lowered ${prev[1]} -> ${places[1]}`, line.text, sup);
      }

      // Swallowed errors: an added catch/except with an empty body, or a recover() in Go.
      if (lang === 'js' && /\bcatch\b/.test(code)) {
        const body = hunk.lines.slice(i + 1, i + 4).filter((l) => l.kind === '+').map((l) => normalize('js', l.text).trim());
        if (/\bcatch\b[^{]*\{\s*\}\s*$/.test(code) || (body.length > 0 && body[0] === '}')) add(ctx, 'error-swallowed', 'medium', line, 'empty catch block added in a test', line.text, sup);
      }
      if (lang === 'py' && /^\s*except\b[^:]*:\s*(?:pass|\.\.\.)?\s*$/.test(code)) {
        const next = hunk.lines.slice(i + 1, i + 3).filter((l) => l.kind === '+').map((l) => normalize('py', l.text).trim())[0];
        if (/^\s*except\b[^:]*:\s*(?:pass|\.\.\.)\s*$/.test(code) || next === 'pass' || next === '...') add(ctx, 'error-swallowed', 'medium', line, 'except ... pass added in a test', line.text, sup);
      }
      if (lang === 'go' && /\bdefer\s+func\s*\(\s*\)\s*\{[^}]*\brecover\s*\(\s*\)/.test(code)) add(ctx, 'error-swallowed', 'medium', line, 'recover() added in a test; panics are hidden', line.text, sup);
    }
  }

  if (file.status === 'added') return;

  // Tests removed: reconcile with tests that moved to another file in the same diff.
  const removedDecls = declarationLines(lang, allRemoved, '-');
  let moved = 0;
  for (const d of removedDecls) if (takeMoved(cross, file.path, d)) moved++;
  // Loops and unparseable tables hide tests/assertions from a line counter; parseable .each rows are counted exactly.
  const tableRefactor = (LOOP_ONLY.test(addedText) || after.unknownEach) && count(lang === 'other' ? /$^/ : COUNTERS[lang].assertion, addedText) > 0;
  const dropped = before.tests - after.tests - moved;
  if (dropped > 0) {
    if (tableRefactor) add(ctx, 'tests-removed', 'low', null, `test count dropped ${before.tests} -> ${after.tests} alongside a loop/table refactor (rows not verifiable)`, `${file.path}: ${dropped} fewer test declaration${dropped === 1 ? '' : 's'}`, null);
    else add(ctx, 'tests-removed', dropped >= 2 ? 'high' : 'medium', null, `test count dropped ${before.tests} -> ${after.tests}${moved ? ` (${moved} moved to another file)` : ''}`, `${file.path}: ${dropped} test${dropped === 1 ? '' : 's'} removed`, null);
  } else if (moved > 0) {
    add(ctx, 'tests-moved', 'low', null, `${moved} test${moved === 1 ? '' : 's'} moved to another file`, file.path, null);
  }

  // Assertions removed (only meaningful when the file still has tests and none were removed).
  let lost = before.assertions - after.assertions;
  if (lost > 0 && before.tests > 0 && after.tests >= before.tests) {
    // Callback -> async: the `expect(err).toBeNull()` guard is subsumed by await.
    if (/\basync\b/.test(addedText)) {
      const guards = allRemoved.filter((r) => /\bexpect\s*\(\s*(?:err|error|e)\s*\)\s*\.(?:toBeNull|toBeFalsy|toBeUndefined)\s*\(/.test(normalize(lang, r.text))).length;
      lost -= guards;
    }
    // Assertions moved into a newly added helper that is called from several places.
    const helper = /^\s*(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|func\s+([A-Za-z_]\w*)\s*\(|def\s+([A-Za-z_]\w*)\s*\()/;
    const assertRe = lang === 'other' ? null : COUNTERS[lang].assertion;
    let helperCalls = 0;
    for (let k = 0; k < addedNorm.length; k++) {
      const m = helper.exec(addedNorm[k] as string);
      const name = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
      if (!name || /^(?:test|it|describe)$/i.test(name) || !assertRe) continue;
      const body = addedNorm.slice(k + 1, k + 40).join('\n');
      if (count(assertRe, body) === 0) continue;
      const calls = count(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g'), afterText ? normalizeFile(lang, afterText) : '') - 1;
      if (calls >= 2) helperCalls += calls;
    }
    if (lost > 0) {
      if (tableRefactor) {
        add(ctx, 'assertions-removed', 'low', null, `assertion count dropped ${before.assertions} -> ${after.assertions} alongside a loop/table refactor`, `${file.path}: ${lost} fewer assertion${lost === 1 ? '' : 's'} in the text`, null);
      } else if (helperCalls > 0) {
        add(ctx, 'assertions-removed', 'low', null, `assertion count dropped ${before.assertions} -> ${after.assertions}; assertions appear to have moved into a helper called ${helperCalls + 1} times`, `${file.path}: ${lost} fewer assertion${lost === 1 ? '' : 's'} in the text`, null);
      } else {
        const sev: Severity = lost >= 3 || (lost >= 2 && lost / Math.max(1, before.assertions) > 0.3) ? 'high' : 'medium';
        add(ctx, 'assertions-removed', sev, null, `assertion count dropped ${before.assertions} -> ${after.assertions} with no test removed`, `${file.path}: ${lost} assertion${lost === 1 ? '' : 's'} removed`, null);
      }
    }
  }
}

// --- detectors over config / CI files --------------------------------------------------------------

/** Commands that actually run tests (lint/typecheck are deliberately not here). */
const TEST_ONLY = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:\w+|e2e)\b|\b(?:npx\s+)?(?:vitest|jest|mocha|ava|tap|node\s+--test|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|make\s+(?:test|tests|check)|tox|nox|rspec|phpunit)\b/;
const TEST_SCRIPT_KEY = /"(?:test|tests|test:\w+|pretest|posttest|ci|check|verify|e2e)"\s*:/;
const BENIGN_IGNORE = /^\s*['"`]?\/?(?:node_modules|dist|build|coverage|\.next|\.nuxt|out|lib|\.git|\.cache|vendor|target|__pycache__|\.venv|venv)\/?\**['"`]?\s*$/;
const BENIGN_PLUGINS = /-p\s+no:(?:cacheprovider|warnings|randomly|cov|faulthandler|logging|xdist)\b/;

const CONFIG_SABOTAGE: Array<{ re: RegExp; severity: Severity; message: string; only?: RegExp; id?: string }> = [
  { re: /testPathIgnorePatterns|testIgnore|ignorePatterns\s*[:=]|modulePathIgnorePatterns/, severity: 'critical', message: 'test ignore pattern added', id: 'ignore' },
  { re: /\b(?:testMatch|testRegex|include|spec)\s*[:=]/, severity: 'high', message: 'test file selection narrowed or changed', only: /(?:jest|vitest|vite|playwright|cypress|karma|mocha|ava)\.config|\.mocharc|jest\.config\.json/, id: 'selection' },
  { re: /\b(?:exclude|ignore)\s*[:=]\s*\[/, severity: 'high', message: 'test exclude list changed', only: /(?:vitest|vite|playwright)\.config|\.mocharc/, id: 'ignore' },
  { re: /--passWithNoTests|passWithNoTests\s*[:=]\s*true/, severity: 'critical', message: 'passWithNoTests: a suite with zero tests is reported green' },
  { re: /--testPathPattern[=\s]|--testNamePattern[=\s]|\s-t\s+["']|\s--grep\s|\s-g\s+["']|go\s+test\b.*(?:\s-run\s+\S+|\s-short\b)|\bpytest\b.*\s-k\s+["']?(?!not\b)\w/, severity: 'high', message: 'test selection narrowed on the command line' },
  { re: /\|\|\s*true\b|\|\|\s*exit\s+0\b|;\s*true\s*["']?\s*,?\s*$|;\s*exit\s+0\s*["']?\s*,?\s*$/, severity: 'critical', message: 'exit status forced to success', id: 'exit' },
  { re: /continue-on-error\s*:\s*(?:true|\$\{\{[^}]*\}\})/, severity: 'critical', message: 'CI step failures ignored (continue-on-error)', id: 'coe' },
  { re: /^\s*if\s*:\s*(?:['"]?false['"]?|\$\{\{\s*false\s*\}\})\s*(?:#.*)?$/, severity: 'critical', message: 'CI step disabled with if: false' },
  { re: /--no-verify\b|--no-gpg-sign\b/, severity: 'high', message: 'git hooks bypassed (--no-verify)' },
  { re: /\bpytest\b.*(?:-p\s+no:|--ignore[=\s]|--deselect[=\s]|-k\s+["']?not\b)|addopts\s*=.*(?:-p\s+no:|--ignore|--deselect|-k\s+["']?not\b)/, severity: 'high', message: 'pytest collection narrowed (ignore/deselect/-k not/-p no:)', id: 'pytest' },
  { re: /\b(?:norecursedirs|python_files|testpaths)\s*=/, severity: 'medium', message: 'pytest discovery configuration changed' },
  { re: /"test"\s*:\s*"(?:echo\b|true\b|exit 0\b|:\s*")/, severity: 'critical', message: 'test script neutered' },
  { re: /--updateSnapshot\b|\s-u\b.*(?:jest|vitest)|(?:jest|vitest).*\s-u\b|\bupdateSnapshot\s*[:=]\s*true|SNAPSHOT_UPDATE|--update-snapshots\b/, severity: 'medium', message: 'snapshots updated automatically' },
  { re: /\bskipLibCheck\b|\bnoEmitOnError\s*:\s*false/, severity: 'low', message: 'type checking relaxed' },
  { re: /\btimeout\s*[:=]\s*\d{6,}/, severity: 'low', message: 'very large timeout added' },
];

function quoted(text: string): string[] {
  return [...text.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1] as string);
}

function scanConfigFile(ctx: Ctx, movedPair: boolean): void {
  const { file } = ctx;
  const p = file.path.replace(/\\/g, '/');
  const isWorkflow = /(^|\/)\.github\/workflows\//.test(p);
  const isJson = p.endsWith('.json');
  const isMakefile = /(^|\/)makefile$/i.test(p);
  if (file.status === 'deleted') {
    if (isWorkflow && !movedPair) add(ctx, 'ci-workflow-deleted', 'high', null, 'CI workflow deleted', file.path, null);
    return;
  }
  for (const hunk of file.hunks) {
    const addedLines = hunk.lines.filter((l) => l.kind === '+');
    const addedText = addedLines.map((l) => l.text).join('\n');
    const removedLines = hunk.lines.filter((l) => l.kind === '-');
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i] as DiffLine;
      if (line.kind === '-') {
        if (TEST_ONLY.test(line.text) && !TEST_ONLY.test(addedText) && !(isJson && !TEST_SCRIPT_KEY.test(line.text) && /"(?:lint|build|start|dev|prepare|format)"\s*:/.test(line.text))) {
          add(ctx, 'test-step-removed', 'high', line, 'a test command was removed from configuration', line.text, null);
        }
        continue;
      }
      if (line.kind !== '+') continue;
      const text = line.text;
      // Comments are prose, not configuration.
      if (!isJson && /^\s*#/.test(text)) continue;
      if (/^\s*\/\//.test(text)) continue;
      const sup = suppression(hunk.lines, i);
      for (const rule of CONFIG_SABOTAGE) {
        if (rule.only && !rule.only.test(p)) continue;
        if (!rule.re.test(text)) continue;
        let severity = rule.severity;
        let message = rule.message;
        if (rule.id === 'exit') {
          // `|| true` only matters on a command that runs tests (or the test script itself); a `clean` recipe or `prepare` script is idiom.
          const testish = TEST_ONLY.test(text) || (isJson && TEST_SCRIPT_KEY.test(text)) || (isMakefile && TEST_ONLY.test(hunk.lines.slice(Math.max(0, i - 3), i).map((l) => l.text).join('\n')));
          if (!testish) continue;
        }
        if (rule.id === 'coe') {
          // Only the step that contains the key matters: walk back to its `- name/run/uses:` line.
          let start = i;
          while (start > 0 && !/^\s*-\s+(?:name|run|uses)\s*:/.test((hunk.lines[start] as DiffLine).text)) start--;
          let end = i + 1;
          while (end < hunk.lines.length && !/^\s*-\s+(?:name|run|uses)\s*:/.test((hunk.lines[end] as DiffLine).text)) end++;
          const step = hunk.lines.slice(start, end).filter((l) => l.kind !== '-').map((l) => l.text).join('\n');
          if (!TEST_ONLY.test(step)) {
            severity = 'medium';
            message = 'continue-on-error added to a CI step (not obviously a test step)';
          }
        }
        if (rule.id === 'ignore') {
          const entries = quoted(text);
          if (entries.length > 0 && entries.every((e) => BENIGN_IGNORE.test(e))) continue;
        }
        if (rule.id === 'selection') {
          // A widened selection (every old pattern kept) is not a narrowing.
          const key = /\b(testMatch|testRegex|include|spec)\s*[:=]/.exec(text)?.[1];
          const prev = removedLines.find((r) => key && new RegExp(`\\b${key}\\s*[:=]`).test(r.text));
          const oldPatterns = prev ? quoted(prev.text) : [];
          const newPatterns = quoted(text);
          if (oldPatterns.length > 0 && oldPatterns.every((o) => newPatterns.includes(o))) continue;
          if (!prev && newPatterns.every((n) => /\*\*\/\*\.(?:\{[^}]*\}|test|spec)/.test(n) || /__tests__/.test(n))) continue;
        }
        if (rule.id === 'pytest' && BENIGN_PLUGINS.test(text) && !/--ignore|--deselect|-k\s+["']?not\b/.test(text)) continue;
        add(ctx, 'config-weakened', severity, line, message, text, sup);
        break;
      }
    }
  }
}

// --- entry point ----------------------------------------------------------------------------------

function normalizeContent(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

/** Pair deleted files with identical added files (an unstaged rename) so a move is not a deletion. */
function findMovedPairs(files: DiffFile[], opts: ScanOptions): Set<string> {
  const paired = new Set<string>();
  const added = files.filter((f) => f.status === 'added' && !f.binary);
  for (const del of files.filter((f) => f.status === 'deleted' && !f.binary)) {
    const before = opts.readBefore(del.path);
    if (before === null) continue;
    const norm = normalizeContent(before);
    const match = added.find((a) => !paired.has(a.path) && normalizeContent(opts.readAfter(a.path) ?? '\0') === norm);
    if (match) {
      paired.add(del.path);
      paired.add(match.path);
    }
  }
  return paired;
}

export function scanIntegrity(files: DiffFile[], opts: ScanOptions): IntegrityReport {
  const findings: Finding[] = [];
  const summary: IntegritySummary = { testsBefore: 0, testsAfter: 0, assertionsBefore: 0, assertionsAfter: 0, skippedBefore: 0, skippedAfter: 0 };
  let testFiles = 0;
  const pairs = findMovedPairs(files, opts);

  // Test declarations added per file (for cross-file move reconciliation).
  const cross: CrossFile = { addedByFile: new Map() };
  for (const file of files) {
    if (file.binary || !isTestFile(file.path)) continue;
    const lang = langOf(file.path);
    const titles = new Map<string, number>();
    for (const d of declarationLines(lang, file.hunks.flatMap((h) => h.lines), '+')) titles.set(d, (titles.get(d) ?? 0) + 1);
    cross.addedByFile.set(file.path, titles);
  }

  for (const file of files) {
    if (file.binary) continue;
    const lang = langOf(file.path);
    const ctx: Ctx = { file, lang, findings, ci: opts.ci ?? false };
    const movedPair = pairs.has(file.path);
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
      if (!(movedPair && file.status === 'added')) scanTestFile(ctx, opts, cross, movedPair);
    }
    if (isTestConfigFile(file.path)) scanConfigFile(ctx, movedPair);
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
