/**
 * Test-integrity scan: did the change weaken the tests that are about to be trusted?
 * Line/regex over diff hunks, no AST. Every detector is a heuristic with a severity tier; only
 * high/critical findings can block, and only in strict mode. Suppress a line with
 *   // isitdone: allow <reason>     # isitdone: allow <reason>
 * Suppressed findings are still reported, never hidden.
 */
import type { DiffFile, DiffLine } from './diff.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Lang = 'js' | 'py' | 'go' | 'rust' | 'java' | 'csharp' | 'other';
/** Languages whose test declaration is an attribute/annotation line that is identical for every test. */
type AttrLang = 'rust' | 'java' | 'csharp';
const isAttrLang = (lang: Lang): lang is AttrLang => lang === 'rust' || lang === 'java' || lang === 'csharp';

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
  if (p.endsWith('.rs')) return 'rust';
  // Kotlin shares the JUnit annotations and kotlin.test uses the JUnit assertion names; Kotest/Spek DSLs are not
  // understood (they count as zero tests, so nothing fires). unverified: Kotlin parity beyond JUnit/kotlin.test.
  if (p.endsWith('.java') || p.endsWith('.kt')) return 'java';
  if (p.endsWith('.cs')) return 'csharp';
  return 'other';
}

/** Content that marks a file as holding tests when its path does not (Rust inline `#[cfg(test)]` modules, Maven names, C# anywhere). */
const SNIFF: Record<AttrLang, RegExp> = {
  // verified: cargo runs #[test] fns inside any lib/bin target; the module is normally gated with #[cfg(test)]
  // (https://doc.rust-lang.org/book/ch11-01-writing-tests.html)
  rust: /^[ \t]*#\[\s*cfg\s*\((?:all|any)?\(?\s*test\b|^[ \t]*#\[\s*(?:[\w:]+::)?(?:test|rstest|quickcheck|wasm_bindgen_test|test_case|test_matrix)\b/m,
  java: /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/m,
  csharp: /^\s*\[\s*(?:Fact|Theory|Test|TestMethod|TestCase|DataTestMethod)\b/m,
};
const MAX_SNIFF_BYTES = 1024 * 1024;

/**
 * Surefire/Failsafe default includes: only these names are run by Maven, case-sensitively
 * (verified: https://maven.apache.org/surefire/maven-surefire-plugin/examples/inclusion-exclusion.html,
 * https://maven.apache.org/surefire/maven-failsafe-plugin/examples/inclusion-exclusion.html).
 */
const MAVEN_TEST_NAME = /^(?:Test[^/]*|[^/]*(?:Test|Tests|TestCase|IT|ITCase)|IT[^/]*)\.java$/;

/**
 * Is this a test file? Path rules first; for Rust, Java/Kotlin and C# a lazy content sniff (`readers`, tried in
 * order until one matches, each bounded to 1 MiB) accepts files the path rules miss: `src/foo.rs` with an inline
 * `#[cfg(test)] mod tests`, a Maven test class outside src/test, a C# test class in any folder.
 */
export function isTestFile(path: string, readers?: Array<() => string | null>): boolean {
  const raw = path.replace(/\\/g, '/');
  const rawBase = raw.split('/').pop() ?? raw; // case preserved: Maven and PascalCase suffixes are case-sensitive (Latest.cs is not a test)
  const p = raw.toLowerCase();
  const base = p.split('/').pop() ?? p;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  const lang = langOf(p);
  if (/(^|\/)(?:__tests__|tests?|spec|specs|e2e|integration)\//.test(p) && (lang === 'js' || lang === 'py' || lang === 'go')) return true;
  if (/^test_.*\.py$|_test\.py$|^tests?\.py$|^conftest\.py$/.test(base)) return true;
  if (/_test\.go$/.test(base)) return true;
  if (lang === 'rust') {
    // verified: every file under tests/ is an integration-test crate; benches/ and examples/ are not run as tests
    // (https://doc.rust-lang.org/cargo/reference/cargo-targets.html)
    if (/(^|\/)tests\//.test(p)) return true;
    if (/(?:^|\/)(?:tests?|test_[^/]*|[^/]*_tests?)\.rs$/.test(p)) return true; // src/foo/tests.rs, src/foo_test.rs (`mod tests;` split out)
  }
  if (lang === 'java') {
    if (/(^|\/)src\/(?:test|it|integrationtest|integration-test|functionaltest|androidtest|jvmtest|commontest)\//.test(p)) return true;
    if (MAVEN_TEST_NAME.test(rawBase) && !/(^|\/)src\/main\//.test(p)) return true;
    if (/(?:Test|Tests|Spec)\.kt$/.test(rawBase)) return true;
  }
  if (lang === 'csharp') {
    // unverified: no runner-level file convention exists for .NET; these are the tutorial/community names
    // (https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-csharp-with-xunit)
    if (/(^|\/)[^/]*\.(?:tests?|unittests|integrationtests|specs?)\//.test(p) || /(^|\/)(?:tests?|specs?|unittests|integrationtests)\//.test(p)) return true;
    if (/(?:Tests?|Specs?|Fixture)\.cs$/.test(rawBase)) return true;
  }
  if (readers && isAttrLang(lang)) {
    for (const read of readers) {
      const text = read();
      if (text && text.length <= MAX_SNIFF_BYTES && SNIFF[lang].test(text)) return true;
    }
  }
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
  if (['bitbucket-pipelines.yml', '.travis.yml', '.drone.yml', 'cloudbuild.yaml', 'justfile', 'Justfile', 'Taskfile.yml'].includes(base) || /(^|\/)\.buildkite\/[^/]+\.ya?ml$/.test(p)) return true;
  // Rust: cargo targets/profiles, cargo config (runner!), nextest profiles.
  if (base === 'Cargo.toml' || /(^|\/)\.cargo\/config(?:\.toml)?$/.test(p) || base === 'nextest.toml') return true;
  // JVM: Maven, Gradle, TestNG suites, JUnit platform properties.
  if (['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'testng.xml', 'junit-platform.properties'].includes(base) || /(^|\/)\.mvn\/maven\.config$/.test(p)) return true;
  // .NET: project files, MSBuild imports, VSTest run settings, xUnit runner config.
  if (/\.(?:cs|fs|vb)proj$|\.runsettings$/.test(base) || base === 'Directory.Build.props' || base === 'Directory.Build.targets' || base === 'xunit.runner.json') return true;
  return false;
}

// --- text normalisation ---------------------------------------------------------------------------

/**
 * Blank the contents of string literals so `it.only(` inside a string (e.g. a test of a linter) is not a call.
 * Rust, Java and C# have single-character `'x'` literals only; a Rust lifetime (`&'a str`) has no closing quote and
 * must not blank the rest of the line, so those languages use the exactly-one-char pattern.
 */
function stripStrings(text: string, lang: Lang = 'other'): string {
  const re = isAttrLang(lang)
    ? /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\(?:u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.))'|`(?:[^`\\\n]|\\.)*`/g
    : /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g;
  return text.replace(re, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[m.length - 1]);
}

/** Comments removed, strings intact: for comparing lines. */
function stripComment(lang: Lang, text: string): string {
  if (lang === 'py') return text.replace(/#.*$/, '');
  return text.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

/** Comments removed and strings blanked: for pattern matching on one line. */
function normalize(lang: Lang, text: string): string {
  return stripComment(lang, stripStrings(text, lang));
}

/** Whole-file normalisation for counting: strings blanked, comments blanked. Length-preserving, so offsets line up with the original. */
export function normalizeFile(lang: Lang, text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  let out = text.split('\n').map((l) => stripStrings(l, lang)).join('\n');
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
    let rest = lang === 'py' ? l.text : stripStrings(l.text, lang);
    let codeOutside = false;
    let sawToken = false;
    // Walk the line token by token, toggling comment state.
    for (;;) {
      if (open) {
        const close = lang === 'py' ? firstOf(rest, ['"""', "'''"]) : rest.indexOf('*/');
        if (close < 0) {
          rest = '';
          break;
        }
        sawToken = true;
        rest = rest.slice(close + (lang === 'py' ? 3 : 2));
        open = false;
      } else {
        const start = lang === 'py' ? firstOf(rest, ['"""', "'''"]) : rest.indexOf('/*');
        if (start < 0) {
          if (rest.trim() !== '') codeOutside = true;
          break;
        }
        sawToken = true;
        if (rest.slice(0, start).trim() !== '') codeOutside = true;
        rest = rest.slice(start + (lang === 'py' ? 3 : 2));
        open = true;
      }
    }
    // Inside a comment, or a line that is nothing but comment text (including the opener line of a docstring).
    out.push((startsInside || sawToken) && !codeOutside);
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
  rust: {
    // #[test], #[tokio::test(...)] ("expands to #[test]", verified: https://docs.rs/tokio/latest/tokio/attr.test.html), #[rstest] with
    // #[case(..)] rows, #[test_case(..)] rows (each attribute is one test, verified: https://docs.rs/test-case/latest/test_case/).
    test: /^\s*#\[\s*(?:(?:[\w:]+::)?(?:test|rstest|quickcheck|wasm_bindgen_test)\b|test_case\s*\(|test_matrix\s*\(|case\s*[(:])/gm,
    // std assert macros (+debug_), approx/claims/insta/proptest macros, panic!/unreachable!; .unwrap()/.expect() are the idiomatic
    // "this must succeed" in a test and `?` in a test returning Result fails it on Err (verified: Book 11.1).
    assertion:
      /\b(?:debug_)?assert(?:_eq|_ne|_matches)?!\s*\(|\b(?:assert_relative_eq|assert_abs_diff_eq|assert_ulps_eq|assert_relative_ne|assert_abs_diff_ne|assert_ulps_ne|prop_assert(?:_eq|_ne)?|assert_(?:debug_|display_|json_|yaml_|ron_|toml_|csv_|binary_)?snapshot|assert_ok|assert_err|assert_some|assert_none|assert_gt|assert_ge|assert_lt|assert_le|panic|unreachable)!\s*\(|\.(?:unwrap|expect|unwrap_err|expect_err)\s*\(|\?(?=\s*[;.),\]}])/g,
    // #[ignore], #[ignore = "reason"], #[cfg_attr(<pred>, ignore)], test-case `=> ignore` (verified: https://doc.rust-lang.org/reference/attributes/testing.html)
    skip: /#\[\s*ignore\b|#\[\s*cfg_attr\s*\(.*?\bignore\s*\)|=>\s*ignore\b/g,
  },
  java: {
    // JUnit 5 (verified: docs.junit.org Assertions/Disabled/condition pages), JUnit 4 and TestNG all spell the method annotation @Test.
    test: /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|ParameterizedClass)\b/gm,
    // JUnit Assertions, AssertJ/Hamcrest/Truth assertThat*, Mockito verify*, TestNG expectThrows, kotlin.test assertFails*/assertIs/assertContains,
    // JUnit 4 @Test(expected = X.class) and TestNG @Test(expectedExceptions = ...) count as one assertion each.
    assertion:
      /\b(?:assert(?:Equals|NotEquals|True|False|Null|NotNull|Same|NotSame|ArrayEquals|IterableEquals|LinesMatch|Throws|ThrowsExactly|DoesNotThrow|Timeout|TimeoutPreemptively|All|InstanceOf|That|ThatThrownBy|ThatCode|ThatExceptionOfType|ThatNoException|ThatIllegalArgumentException|ThatIllegalStateException|ThatNullPointerException|ThatIOException|WithMessage|Fails|FailsWith|Contains|Is|IsNot|ContentEquals|Soft\w*)|fail|verify|verifyNoMoreInteractions|verifyNoInteractions|expectThrows|inOrder)\s*(?:<[^>\n]*>\s*)?[({]|@Test\s*\([^)]*\bexpected(?:Exceptions)?\s*=/g,
    // @Disabled/@Ignore, the org.junit.jupiter.api.condition annotations, Assumptions (a failed assumption aborts the test), TestNG enabled=false.
    skip: /@(?:Disabled|Ignore)\b|@(?:Disabled|Enabled)(?:If|OnOs|OnJre|ForJreRange|IfSystemProperty|IfSystemProperties|IfEnvironmentVariable|IfEnvironmentVariables|InNativeImage)\b|\b(?:Assumptions\.)?assum(?:eTrue|eFalse|eThat|eNotNull|eNoException|ingThat)\s*\(|\bAssumptions\.abort\s*\(|@Test\s*\([^)]*\benabled\s*=\s*false/g,
  },
  csharp: {
    // xUnit [Fact]/[Theory] + [InlineData] rows, NUnit [Test]/[TestCase] rows, MSTest [TestMethod] + [DataRow] rows (each attribute is one
    // test or one row); attribute lists ([Fact, Trait(...)]) match through the `,` alternative. unverified: MSTest [DataTestMethod] obsolescence.
    test: /\[\s*(?:(?:Xunit|NUnit\.Framework|Microsoft\.VisualStudio\.TestTools\.UnitTesting)\.)?(?:Fact|Theory|Test|TestMethod|DataTestMethod|InlineData|TestCase|DataRow)(?:Attribute)?\s*(?:\(|,|\])/g,
    // Assert.*/ClassicAssert.*/CollectionAssert.*/StringAssert.* (Ignore/Inconclusive/Skip*/Pass/Warn/Multiple are control flow, not checks),
    // FluentAssertions .Should(), Shouldly .ShouldBe(), Moq .Verify(, NSubstitute .Received(.
    assertion: /\b(?:Classic|Collection|String)?Assert\.(?!(?:Ignore|Inconclusive|Skip\w*|Pass|Warn|Multiple|EnterMultipleScope|Scope)\b)\w+(?:<[^>]*>)?\s*\(|\bAssume\.\w+\s*\(|\.Should\s*\(\s*\)|\.Should\w+\s*\(|\.(?:Verify|VerifyAll|VerifyNoOtherCalls|Received|DidNotReceive|ReceivedWithAnyArgs)\s*\(/g,
    // [Fact(Skip = "...")] / [InlineData(..., Skip = "...")] (verified: xunit v2 FactAttribute.Skip, DataAttribute.Skip), xUnit v3 Assert.Skip*,
    // NUnit [Ignore("...")]/[Explicit]/Assert.Ignore/Inconclusive/Assume.That, MSTest [Ignore]. `Skip =`/`Ignore =` only inside an attribute.
    skip: /\[[^\]\n]*\bSkip\s*=\s*(?!null\b)|\[\s*Ignore\b|\[\s*Explicit\b|\bAssert\.(?:Ignore|Inconclusive|Skip|SkipWhen|SkipUnless)\s*\(|\bAssume\.That\s*\(|\[[^\]\n]*\bSkip(?:When|Unless)\s*=|\[[^\]\n]*\bExplicit\s*=\s*true|\[[^\]\n]*\bIgnore(?:Message|Reason)?\s*=\s*"/g,
  },
};

/**
 * Rust: the byte ranges of `#[cfg(test)]`-gated items (normalised text). Production `assert!`/`.unwrap()` in the same
 * file must not count as test assertions. Null when the file has no gate (an integration test under tests/).
 */
function rustTestRegions(norm: string): Array<[number, number]> | null {
  const gate = /^[ \t]*#\[\s*cfg\s*\((?:all|any)?\(?\s*test\b[^\n]*/gm;
  const regions: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = gate.exec(norm))) {
    const start = m.index;
    let i = m.index + m[0].length;
    // The gated item: up to the matching `}` of the first block, or the `;` of a `mod tests;` / `use` line.
    let depth = 0;
    let end = -1;
    for (; i < norm.length; i++) {
      const ch = norm[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      } else if (ch === ';' && depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) end = norm.length;
    regions.push([start, end]);
    gate.lastIndex = end;
  }
  return regions.length > 0 ? regions : null;
}

/** 1-based line numbers covered by `regions` (null = every line). */
function regionLines(text: string, regions: Array<[number, number]> | null): Set<number> | null {
  if (!regions) return null;
  const lines = new Set<number>();
  let lineNo = 1;
  let r = 0;
  for (let i = 0; i < text.length; i++) {
    while (r < regions.length && i >= (regions[r] as [number, number])[1]) r++;
    if (r < regions.length && i >= (regions[r] as [number, number])[0]) lines.add(lineNo);
    if (text[i] === '\n') lineNo++;
  }
  return lines;
}

/** Text from `from` to the end of the first balanced `{...}` block that follows (empty when none within 2000 chars). */
function blockAfter(text: string, from: number): string {
  const open = text.indexOf('{', from);
  if (open < 0 || open - from > 2000) return '';
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const ch = text[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open, j + 1);
    }
  }
  return '';
}

/** Data-row attributes of a parameterised test: each is one test whose body assertions run once more. */
const ROW_ATTR: Record<AttrLang, RegExp> = {
  rust: /^[ \t]*#\[\s*(?:case\s*[(:]|test_case\s*\()/gm,
  java: /(?!)/g, // Java rows are @CsvSource strings, credited by javaSourceRows
  csharp: /^[ \t]*\[\s*(?:InlineData|TestCase|DataRow)\b/gm,
};
const UNKNOWN_ROWS: Record<AttrLang, RegExp> = {
  rust: /#\[\s*(?:values|test_matrix)\b|\bproptest!\s*\{|#\[\s*quickcheck\b/,
  java: /@(?:MethodSource|EnumSource|FieldSource|ArgumentsSource|CsvFileSource|TestFactory)\b|@CsvSource\s*\([^)]*\btextBlock\s*=|^[ \t]*@Test(?:\([^)]*\))?[ \t]*(?:\r?\n[ \t]*)*(?:(?:public|abstract|final)\s+)*class\b/m,
  csharp: /\[\s*(?:MemberData|ClassData|TestCaseSource|DynamicData|Values|Combinatorial\w*|Pairwise|Sequential)\b/,
};

/**
 * Assertion credit for attribute rows: `[Theory]` + 3 `[InlineData]` is 4 tests (the counter already says so) and
 * the body's assertions run 4 times. Groups of rows count `rows` when a non-row test attribute precedes them
 * (`[Theory]`, `#[rstest]`, `[Test]`), `rows - 1` when the rows are the only declaration (`#[test_case]`).
 */
function rowAssertionCredit(lang: AttrLang, norm: string, assertion: RegExp): number {
  const re = new RegExp(ROW_ATTR[lang].source, 'gm');
  let credit = 0;
  let m: RegExpExecArray | null;
  let groupEnd = -1;
  while ((m = re.exec(norm))) {
    if (m[0] === '') re.lastIndex++; // never loop on an empty match
    if (m.index < groupEnd) continue;
    // Walk the run of attribute lines that starts here.
    let rows = 0;
    let headed = false;
    let pos = m.index;
    const lineRe = /[^\n]*\n?/y;
    for (;;) {
      lineRe.lastIndex = pos;
      const l = lineRe.exec(norm);
      if (!l || l[0] === '') break;
      const t = l[0].trim();
      if (t === '') {
        pos += l[0].length;
        continue;
      }
      const isAttr = lang === 'rust' ? /^#\[/.test(t) : /^\[/.test(t);
      if (!isAttr) break;
      if (new RegExp(ROW_ATTR[lang].source).test(t)) rows++;
      else if (new RegExp(COUNTERS[lang].test.source).test(t)) headed = true;
      pos += l[0].length;
    }
    // Rows above the group (Rust `#[rstest]` sits above `#[case]`; the C# `[Theory]` too) — look back one line.
    const before = norm.slice(Math.max(0, norm.lastIndexOf('\n', m.index - 2)), m.index).trim();
    if (before !== '' && new RegExp(COUNTERS[lang].test.source).test(before) && !new RegExp(ROW_ATTR[lang].source).test(before)) headed = true;
    groupEnd = pos;
    const n = count(assertion, blockAfter(norm, pos));
    credit += Math.max(0, rows - (headed ? 0 : 1)) * n;
  }
  return credit;
}

/** Java `@CsvSource({...})` / `@ValueSource(x = {...})`: literal rows counted on the raw text (strings are blanked in `norm`). */
function javaSourceRows(text: string, norm: string, assertion: RegExp): { tests: number; assertions: number } {
  const re = /@(?:CsvSource|ValueSource)\s*\(/g;
  let tests = 0;
  let assertions = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) {
    const open = norm.indexOf('{', m.index);
    if (open < 0 || open - m.index > 200) continue;
    let depth = 0;
    let close = -1;
    for (let j = open; j < norm.length; j++) {
      if (norm[j] === '{') depth++;
      else if (norm[j] === '}') {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) continue;
    const inner = text.slice(open + 1, close);
    const rows = /"/.test(inner) ? (inner.match(/"(?:[^"\\]|\\.)*"/g) ?? []).length : splitTopLevel(inner).length;
    if (rows <= 1) continue;
    tests += rows - 1;
    assertions += (rows - 1) * count(assertion, blockAfter(norm, close));
  }
  return { tests, assertions };
}

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
  let norm = normalizeFile(lang, text);
  if (lang === 'rust') {
    // Only the #[cfg(test)] regions of a source file hold tests; blank everything else (length-preserving).
    const regions = rustTestRegions(norm);
    if (regions) {
      let out = '';
      let at = 0;
      for (const [s, e] of regions) {
        out += norm.slice(at, s).replace(/[^\n]/g, ' ') + norm.slice(s, e);
        at = e;
      }
      norm = out + norm.slice(at).replace(/[^\n]/g, ' ');
    }
  }
  let tests = count(c.test, norm);
  let assertions = count(c.assertion, norm);
  let unknownEach = false;
  if (isAttrLang(lang)) {
    assertions += rowAssertionCredit(lang, norm, c.assertion);
    if (lang === 'java') {
      const rows = javaSourceRows(text, norm, c.assertion);
      tests += rows.tests;
      assertions += rows.assertions;
    }
    if (UNKNOWN_ROWS[lang].test(norm)) unknownEach = true;
  }
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
/** A strong (value-comparing) assertion next to a new existence check on the same subject is not a downgrade. */
const STRONG_MATCHER: Record<Lang, RegExp> = {
  js: /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toContainEqual|toHaveProperty|toMatch|toThrow|toHaveBeenCalledWith|toHaveBeenCalledTimes|toBeCloseTo|toBeGreaterThan|toBeLessThan|toMatchSnapshot|toMatchInlineSnapshot)\s*\(/,
  py: /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toContainEqual|toHaveProperty|toMatch|toThrow|toHaveBeenCalledWith|toHaveBeenCalledTimes|toBeCloseTo|toBeGreaterThan|toBeLessThan|toMatchSnapshot|toMatchInlineSnapshot)\s*\(/,
  go: /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toContainEqual|toHaveProperty|toMatch|toThrow|toHaveBeenCalledWith|toHaveBeenCalledTimes|toBeCloseTo|toBeGreaterThan|toBeLessThan|toMatchSnapshot|toMatchInlineSnapshot)\s*\(/,
  rust: /\bassert_(?:eq|ne|matches)!\s*\(|\bassert!\s*\([^;]*(?:==|!=|<|>|\.contains\(|\.starts_with\(|\.ends_with\()|\bassert_(?:relative|abs_diff|ulps)_eq!/,
  java: /\bassert(?:Equals|ArrayEquals|IterableEquals|Same|LinesMatch|Throws|ThrowsExactly)\s*\(|\.(?:isEqualTo|isSameAs|containsExactly|containsExactlyInAnyOrder|hasSize|isInstanceOf|contains|startsWith|endsWith|hasMessage)\s*\(/,
  csharp: /\bAssert\.(?:Equal|AreEqual|Same|AreSame|Equivalent|StrictEqual|Contains|Throws|ThrowsExactly|That\s*\([^,]+,\s*Is\.(?:EqualTo|SameAs))|\.Should\(\)\.(?:Be|BeEquivalentTo|Equal|Contain|HaveCount|Throw|StartWith|EndWith)\s*\(/,
  other: /$^/,
};
const LOOP_ONLY = /\bfor\s*\(|\.forEach\s*\(|\.map\s*\(|\bwhile\s*\(|@pytest\.mark\.parametrize|^\s*for\s+[\p{L}\p{N}_,\s]+\s+in\b|\bt\.Run\s*\(|\brange\s+\w+|\bfor\s+[\w(),&\s]+\s+in\b|\.for_each\s*\(|#\[\s*(?:rstest|values|test_matrix)\b|\bforeach\s*\(|\bAssert\.(?:Multiple|All)\s*\(|\bassertAll\s*\(|DynamicTest\.dynamicTest\s*\(/mu;
/** Matched on the normalised line (strings blanked); literal-vs-same-literal forms live in TAUTOLOGY_RAW. */
const TAUTOLOGY: Record<Exclude<Lang, 'other'>, RegExp> = {
  js: /\bexpect\s*\(\s*(?:true|false|null|undefined|\d+|'\s*'|"\s*"|`\s*`)\s*\)\s*\.(?:not\.)?(?:toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy|toBeDefined|toBeNull|toBeUndefined)\s*\(/,
  py: /^\s*assert\s+(?:True|1|"\s*"|'\s*')\s*(?:#.*)?$|\bself\.assertTrue\s*\(\s*True\s*\)|\bself\.assertEqual\s*\(\s*(\w+)\s*,\s*\1\s*\)/,
  go: /\b(?:assert|require)\.True\s*\(\s*t\s*,\s*true\s*\)|\b(?:assert|require)\.Equal\s*\(\s*t\s*,\s*(\w+)\s*,\s*\1\s*\)/,
  rust: /\b(?:debug_)?assert!\s*\(\s*(?:true|!false|1\s*==\s*1)\s*[,)]|\bassert_eq!\s*\(\s*([A-Za-z_][\w.:()]*)\s*,\s*\1\s*[,)]|\bassert_ne!\s*\(\s*true\s*,\s*false\s*[,)]|\bassert!\s*\(\s*matches!\s*\([^,]+,\s*_\s*\)\s*\)|\bassert!\s*\(\s*(\w+)\.is_ok\(\)\s*\|\|\s*\2\.is_err\(\)/,
  java: /\bassertTrue\s*\(\s*(?:"[^"]*"\s*,\s*)?(?:true|Boolean\.TRUE|!false)\s*[,)]|\bassertFalse\s*\(\s*(?:"[^"]*"\s*,\s*)?(?:false|Boolean\.FALSE|!true)\s*[,)]|\bassert(?:Equals|Same)\s*\(\s*(?:"[^"]*"\s*,\s*)?([A-Za-z_][\w.()]*)\s*,\s*\1\s*[,)]|\bassertNotNull\s*\(\s*(?:new\s+\w+|"|\d|List\.of|Map\.of|Optional\.of)|\bassertNull\s*\(\s*null\s*[,)]|\bassertThat\s*\(\s*true\s*\)\s*\.isTrue\(\)|\bassertThat\s*\(\s*([A-Za-z_][\w.()]*)\s*\)\s*\.is(?:EqualTo|SameAs)\(\s*\2\s*\)|\bassertThat\s*\(\s*([A-Za-z_][\w.()]*)\s*,\s*(?:is\s*\(\s*)?(?:equalTo|sameInstance)\s*\(\s*\3\s*\)|\bassertDoesNotThrow\s*\(\s*\(\)\s*->\s*\{\s*\}\s*\)/,
  csharp: /\bAssert\.(?:True|IsTrue)\s*\(\s*true\s*[,)]|\bAssert\.(?:False|IsFalse)\s*\(\s*false\s*[,)]|\bAssert\.That\s*\(\s*true\s*(?:,\s*Is\.True\s*)?\)|\bAssert\.That\s*\(\s*\(\)\s*=>\s*true\s*\)|\bAssert\.(?:Equal|AreEqual|Same|AreSame|Equivalent|AreEquivalent)\s*\(\s*([A-Za-z_][\w.()]*)\s*,\s*\1\s*[,)]|\bAssert\.(?:NotNull|IsNotNull)\s*\(\s*(?:new\s|"|\d|\[\s*\])|\bAssert\.That\s*\(\s*([A-Za-z_][\w.()]*)\s*,\s*Is\.EqualTo\s*\(\s*\2\s*\)|\btrue\.Should\(\)\.BeTrue\(\)|\b([A-Za-z_][\w.()]*)\.Should\(\)\.Be\(\s*\3\s*\)/,
};
/** Literal compared with the same literal: needs the string contents, so it runs on the comment-stripped raw line. */
const TAUTOLOGY_RAW: Partial<Record<Lang, RegExp>> = {
  rust: /\bassert_eq!\s*\(\s*(-?\d+(?:\.\d+)?|true|false|"[^"]*")\s*,\s*\1\s*[,)]/,
  java: /\bassert(?:Equals|Same)\s*\(\s*(?:"[^"]*"\s*,\s*)?(-?\d+(?:\.\d+)?[LlFfDd]?|"[^"]*"|true|false|null)\s*,\s*\1\s*[,)]/,
  csharp: /\bAssert\.(?:Equal|AreEqual)\s*\(\s*(-?\d+(?:\.\d+)?[mMfFdDL]?|"[^"]*"|true|false|null)\s*,\s*\1\s*[,)]/,
};
// Bare `return`, `if (...) {` + `return` (Go/Rust/JS), the brace-less Java/C# `if (...) return;`, and NUnit's Assert.Pass()
// ("immediately end the test, recording it as successful", verified: docs.nunit.org Assert.Ignore/Pass page).
const EARLY_RETURN = /^\s*(?:if\b[^{]*\{\s*)?return;?\s*\}?\s*$|^\s*if\s*\(.*\)\s*return;\s*$|^\s*Assert\.Pass\s*\(.*\)\s*;\s*$/;

/**
 * A weaker assertion replacing a stronger one on the same subject. `lang` scopes the rule (entries without it are
 * the original JS/Python/Go set); `attr` rules compare the declaration that follows an attribute line instead of
 * call arguments (`#[should_panic(expected = ..)]` -> `#[should_panic]`, `@Test(expected = X)` -> `Exception`).
 */
const DOWNGRADES: Array<{ from: RegExp; to: RegExp; what: string; existence?: boolean; lang?: Lang; attr?: boolean }> = [
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
  { from: /^\s*assert\s+\S.*?(?:==|!=|<=|>=|<|>)\s*\S/, to: /^\s*assert\s+(?:[\w.()\[\]'"]+)\s+is\s+not\s+None\s*$|^\s*assert\s+[\w.()\[\]'"]+\s*$|^\s*assert\s+len\s*\([^)]*\)\s*$|^\s*assert\s+\S+\s*!=\s*None\s*$/, what: 'assert x == value -> existence/truthiness check', existence: true },
  { from: /\bassertRaises\s*\(\s*\w+/, to: /\bassertRaises\s*\(\s*Exception\b/, what: 'assertRaises(Specific) -> assertRaises(Exception)' },
  { from: /\bpytest\.raises\s*\(\s*(?!Exception\b)\w+/, to: /\bpytest\.raises\s*\(\s*(?:Exception|BaseException)\b/, what: 'pytest.raises(Specific) -> raises(Exception)' },
  { from: /\b(?:assert|require)\.(?:Equal|EqualValues|Exactly|Same|ElementsMatch|Len)\s*\(/, to: /\b(?:assert|require)\.(?:NotNil|NotEmpty|True|NoError)\s*\(/, what: 'Equal -> NotNil/NotEmpty/True' },
  // Rust
  { lang: 'rust', from: /\bassert_eq!\s*\(/, to: /\bassert!\s*\([^;]*?\.(?:is_ok|is_some|is_err|is_none)\(\)\s*[,)]|\bassert!\s*\(\s*![^;]*?\.is_empty\(\)|\bassert!\s*\([^;]*?\.len\(\)\s*[>!]=?\s*0/, what: 'assert_eq! -> variant/existence check (is_ok/is_some/!is_empty)', existence: true },
  { lang: 'rust', from: /\bassert_eq!\s*\(/, to: /\bmatches!\s*\([^,]+,\s*(?:Some|Ok|Err)\(\s*_\s*\)|\bmatches!\s*\([^,]+,\s*[\w:]+\s*\{\s*\.\.\s*\}/, what: 'assert_eq!(x, Some(v)) -> matches!(x, Some(_))', existence: true },
  { lang: 'rust', from: /\bmatches!\s*\(/, to: /\.is_(?:ok|err|some|none)\(\)/, what: 'matches!(err, Error::Specific) -> is_err()' },
  { lang: 'rust', from: /\.(?:unwrap|expect)\s*\(/, to: /\.(?:unwrap_or_default|unwrap_or|unwrap_or_else|ok|unwrap_unchecked)\s*\(/, what: '.unwrap() -> .unwrap_or_default()/.ok(): a failure no longer panics', existence: true },
  { lang: 'rust', from: /\bassert_eq!\s*\([^,]*\.len\(\)\s*,\s*\d+/, to: /\bassert!\s*\(\s*![^)]*\.is_empty\(\)/, what: 'assert_eq!(v.len(), n) -> !v.is_empty()', existence: true },
  { lang: 'rust', from: /\bassert_(?:relative|abs_diff|ulps)_eq!\s*\(/, to: /\bassert!\s*\(\s*\([^)]*\)\.abs\(\)\s*</, what: 'approx assertion -> hand-rolled abs() < eps' },
  // verified: the bare form passes on any panic, `expected` requires the message substring (https://doc.rust-lang.org/reference/attributes/testing.html)
  { lang: 'rust', from: /^\s*#\[\s*should_panic\s*(?:\(\s*expected\s*=|=)/, to: /^\s*#\[\s*should_panic\s*\]/, what: '#[should_panic(expected = "...")] -> #[should_panic]: any panic now passes', attr: true },
  // Java
  { lang: 'java', from: /\bassert(?:Equals|ArrayEquals|IterableEquals|Same|LinesMatch)\s*\(/, to: /\bassertNotNull\s*\(|\bassertTrue\s*\(\s*(?:[^)]*!=\s*null|[^)]*\.isPresent\(\)|![^)]*\.isEmpty\(\)|[^)]*\.(?:size|length)\(\)\s*>\s*0|[^)]*\.(?:contains|startsWith|endsWith|containsKey)\s*\(|[^)]*\binstanceof\b)/, what: 'assertEquals -> existence/containment check', existence: true },
  // verified: assertThrows accepts "a given type or a subclass thereof" (docs.junit.org Assertions)
  { lang: 'java', from: /\bassertThrows(?:Exactly)?\s*\(\s*(?!(?:Exception|RuntimeException|Throwable|Error)\b)[\w.]+\.class/, to: /\bassertThrows\s*\(\s*(?:Exception|RuntimeException|Throwable|Error)\.class/, what: 'assertThrows(Specific.class) -> assertThrows(Exception.class)' },
  { lang: 'java', from: /\bassertThrowsExactly\s*\(/, to: /\bassertThrows\s*\(/, what: 'assertThrowsExactly -> assertThrows (subclasses accepted)' },
  { lang: 'java', from: /\bexpected(?:Exceptions)?\s*=\s*(?!(?:Exception|RuntimeException|Throwable)\b)[\w.]+\.class/, to: /\bexpected(?:Exceptions)?\s*=\s*(?:Exception|RuntimeException|Throwable)\.class/, what: '@Test(expected = Specific) -> Exception', attr: true },
  { lang: 'java', from: /\.is(?:EqualTo|SameAs|EqualToComparingFieldByField)\s*\(|\.usingRecursiveComparison\(\)/, to: /\.(?:isNotNull|isNotEmpty|isPresent|isNotBlank|isInstanceOf|isNotEqualTo)\s*\(|\.hasSizeGreaterThan\s*\(\s*0\s*\)/, what: 'AssertJ isEqualTo -> existence check', existence: true },
  { lang: 'java', from: /\.containsExactly(?:InAnyOrder)?\s*\(|\.containsOnly\s*\(/, to: /\.(?:contains|containsAnyOf|isNotEmpty|hasSizeGreaterThan)\s*\(/, what: 'containsExactly -> contains/isNotEmpty' },
  { lang: 'java', from: /\.hasSize\s*\(\s*\d+/, to: /\.(?:isNotEmpty|isNotNull)\s*\(/, what: 'hasSize(n) -> isNotEmpty', existence: true },
  { lang: 'java', from: /\.isInstanceOf\s*\(\s*(?!(?:Exception|RuntimeException|Throwable)\b)[\w.]+\.class|\bassertThatExceptionOfType\s*\(\s*(?!(?:Exception|RuntimeException|Throwable)\b)[\w.]+\.class/, to: /\.isInstanceOf\s*\(\s*(?:Exception|RuntimeException|Throwable)\.class|\bassertThatExceptionOfType\s*\(\s*(?:Exception|RuntimeException|Throwable)\.class/, what: 'AssertJ exception type widened to Exception' },
  { lang: 'java', from: /\bassertThat\s*\([^,]+,\s*(?:is\s*\(\s*)?(?:equalTo|sameInstance|contains|containsInAnyOrder)\s*\(/, to: /\bassertThat\s*\([^,]+,\s*(?:is\s*\(\s*)?(?:notNullValue|not\s*\(\s*nullValue|hasItem|not\s*\(\s*empty)\s*\(/, what: 'Hamcrest equalTo -> notNullValue/hasItem', existence: true },
  { lang: 'java', from: /\bverify\s*\([^)]*\)\s*\.\s*\w+\s*\((?![^)]*\bany\w*\s*\()/, to: /\bverify\s*\([^)]*\)\s*\.\s*\w+\s*\([^)]*\bany(?:String|Int|Long|Boolean|List|Map|Set|Collection|Iterable|Object)?\s*\(\s*\)/, what: 'verify(...).method(exact args) -> any()' },
  { lang: 'java', from: /\bverify\s*\([^,)]+,\s*times\s*\(\s*\d+\s*\)/, to: /\bverify\s*\([^,)]+,\s*(?:atLeastOnce|atLeast|atMost)\s*\(/, what: 'verify(times(n)) -> atLeast/atMost' },
  // C#
  { lang: 'csharp', from: /\bAssert\.(?:Equal|AreEqual|Same|AreSame|Equivalent|AreEquivalent|StrictEqual|Contains|HasCount|AreSequenceEqual)\s*\(/, to: /\bAssert\.(?:NotNull|IsNotNull|NotEmpty|IsNotEmpty|True\s*\(\s*[^)]*!=\s*null|IsTrue\s*\(\s*[^)]*!=\s*null|True\s*\(\s*[^)]*\.Any\(\))/, what: 'Assert.Equal -> NotNull/NotEmpty', existence: true },
  { lang: 'csharp', from: /\bAssert\.That\s*\([^,]+,\s*Is\.(?:EqualTo|EquivalentTo|SameAs|SupersetOf|SubsetOf)\s*\(|\bAssert\.That\s*\([^,]+,\s*Has\.(?:Count|Length|Exactly)/, to: /\bAssert\.That\s*\([^,]+,\s*Is\.Not\.(?:Null|Empty)\b/, what: 'Is.EqualTo -> Is.Not.Null/Empty', existence: true },
  // verified: xUnit Assert.ThrowsAny accepts derived types; NUnit "Throws.TypeOf requires an exact type match" (docs.nunit.org Throws constraint)
  { lang: 'csharp', from: /\bAssert\.Throws<(?!(?:Exception|SystemException|ApplicationException)>)[\w.]+>|\bAssert\.ThrowsExactly(?:Async)?<(?!(?:Exception)>)[\w.]+>|\bAssert\.ThrowsException<(?!(?:Exception)>)[\w.]+>/, to: /\bAssert\.ThrowsAny(?:Async)?<[\w.]+>|\bAssert\.Throws(?:Async|Exception|ExceptionAsync)?<(?:Exception|SystemException|ApplicationException)>/, what: 'Assert.Throws<Specific> -> ThrowsAny/Throws<Exception>' },
  { lang: 'csharp', from: /\bAssert\.ThrowsExactly(?:Async)?</, to: /\bAssert\.Throws(?:Async)?</, what: 'ThrowsExactly -> Throws (derived types accepted)' },
  { lang: 'csharp', from: /\bThrows\.TypeOf<(?!(?:Exception)>)[\w.]+>/, to: /\bThrows\.(?:InstanceOf<(?:Exception|SystemException)>|Exception\b(?!\.)|InstanceOf<[\w.]+>)/, what: 'Throws.TypeOf<T> -> Throws.InstanceOf/Throws.Exception' },
  { lang: 'csharp', from: /\.Should\(\)\.(?:Be|BeEquivalentTo|BeSameAs|HaveCount|ContainSingle|Equal|ContainInOrder)\s*\(/, to: /\.Should\(\)\.(?:NotBeNull|NotBeEmpty|BeOfType|NotBeNullOrEmpty|NotBeNullOrWhiteSpace|HaveCountGreaterThan\s*\(\s*0)\s*\(?/, what: 'Should().Be -> Should().NotBeNull', existence: true },
  { lang: 'csharp', from: /\.Should\(\)\.(?:Throw|ThrowExactly)(?:Async)?<(?!(?:Exception)>)[\w.]+>/, to: /\.Should\(\)\.Throw(?:Async)?<(?:Exception|SystemException)>|\.Should\(\)\.Throw(?:Async)?\s*\(\s*\)/, what: 'Should().Throw<Specific> -> Throw<Exception>' },
  { lang: 'csharp', from: /\.Verify\s*\([^)]*\bIt\.Is(?:<[^>]*>)?\s*\(/, to: /\.Verify\s*\([^)]*\bIt\.IsAny<[^>]*>\s*\(\s*\)/, what: 'Moq It.Is(...) -> It.IsAny<T>()' },
  { lang: 'csharp', from: /\.Verify\s*\([^;]*,\s*Times\.(?:Once|Exactly)\s*\(/, to: /\.Verify\s*\([^;]*,\s*Times\.(?:AtLeastOnce|AtLeast|AtMost|AtMostOnce)\s*\(/, what: 'Times.Once -> Times.AtLeastOnce' },
];

/** Widened tolerances: the captured number grows (`factor`) or the digits shrink (`digits`). JS/Python keep their own checks below. */
const TOLERANCES: Array<{ lang: Lang; re: RegExp; kind: 'digits' | 'factor'; what: string; delta?: boolean }> = [
  { lang: 'rust', re: /\b(?:epsilon|max_relative)\s*=\s*([\d.eE+-]+)/, kind: 'factor', what: 'approx epsilon/max_relative widened' },
  { lang: 'rust', re: /\bmax_ulps\s*=\s*(\d+)/, kind: 'factor', what: 'approx max_ulps widened' },
  { lang: 'rust', re: /\)\.abs\(\)\s*<=?\s*([\d.eE+-]+)/, kind: 'factor', what: 'hand-rolled abs() tolerance widened' },
  { lang: 'java', re: /\bassertEquals\s*\(/, kind: 'factor', what: 'assertEquals delta widened', delta: true },
  { lang: 'java', re: /\b(?:within|offset|withPrecision|byLessThan)\s*\(\s*([\d.eE+-]+)/, kind: 'factor', what: 'AssertJ tolerance widened' },
  { lang: 'java', re: /\bcloseTo\s*\([^,]+,\s*([\d.eE+-]+)/, kind: 'factor', what: 'Hamcrest closeTo tolerance widened' },
  { lang: 'csharp', re: /\bAssert\.Equal\s*\([^;]*,\s*(?:precision:\s*)?(\d+)\s*\)\s*;/, kind: 'digits', what: 'Assert.Equal precision lowered' },
  { lang: 'csharp', re: /\.Within\s*\(\s*([\d.eE+-]+)/, kind: 'factor', what: 'NUnit Within tolerance widened' },
  { lang: 'csharp', re: /\bBeApproximately\s*\([^,]+,\s*([\d.eE+-]+)/, kind: 'factor', what: 'BeApproximately tolerance widened' },
  { lang: 'csharp', re: /\bAssert\.AreEqual\s*\(/, kind: 'factor', what: 'AreEqual delta widened', delta: true },
];

/** The tolerance a line carries for `t`, or null: the captured number, or (delta forms) a numeric third-or-later argument. */
function toleranceOf(t: { re: RegExp; delta?: boolean }, code: string): number | null {
  const m = t.re.exec(code);
  if (!m) return null;
  if (!t.delta) return Number(m[1]);
  const args = splitArgs(code, m.index + m[0].length - 1);
  const last = (args[args.length - 1] ?? '').trim();
  return args.length >= 3 && /^[\d.eE+-]*\d[\d.eE+-]*[fFdDmM]?$/.test(last) ? Number(last.replace(/[fFdDmM]$/, '')) : null;
}

/**
 * The value under test: `expect(x)` prefix; for unittest `self.assertX(first, ...)` the first argument; for a plain
 * `assert x == y` the left operand; for testify the last argument.
 */
function subjectOf(lang: Lang, text: string): string {
  const squash = (s: string) => s.replace(/\s+/g, '').slice(-60);
  if (lang === 'go') {
    const m = /\b(?:assert|require)\.\w+\s*\(([\s\S]*)\)\s*$/.exec(text.trim());
    if (m) {
      const args = splitTopLevel(m[1] as string);
      return squash(args[args.length - 1] ?? '');
    }
  }
  if (lang === 'py') {
    const u = /\bself\.assert\w+\s*\(([\s\S]*)\)\s*$/.exec(text.trim());
    if (u) return squash(splitTopLevel(u[1] as string)[0] ?? '');
    const plain = /^\s*assert\s+(.+?)\s*(?:==|!=|<=|>=|<|>|\bis\b|\bin\b|\bnot\b|$)/.exec(text);
    if (plain) return squash(plain[1] as string);
  }
  const m = /^(.*?)\.(?:to[A-Z]\w*|not)\b/.exec(text) ?? /^(.*?)\b(?:pytest\.raises|assertRaises)\s*\(/.exec(text) ?? /^(.*?)\b(?:assert\w*|require\.\w+)\s*\(/.exec(text);
  return squash(m?.[1] ?? text);
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

/** Top-level arguments of the call whose `(` is at `open` in raw text (string-aware, so `f("(")` is one argument). */
function splitArgs(text: string, open: number): string[] {
  if (text[open] !== '(') return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      cur += ch;
      if (ch === '\\') {
        cur += text[i + 1] ?? '';
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        if (cur.trim() !== '') out.push(cur);
        return out;
      }
    }
    if (ch === ',' && depth === 1) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

const LITERAL_ARG = /^(?:-?\d[\w.]*|b?["'].*|true|false|null|None|Boolean\.(?:TRUE|FALSE))$/;
const WEAK_SUFFIX = /(?:\.(?:unwrap|expect|unwrap_err|expect_err|clone|as_str|to_string|as_ref|is_ok|is_some|is_err|is_none|is_empty|isPresent|isEmpty|size|len|length|Any|Count|ToString|ToList|ToArray)\s*\([^()]*\)|\?|\.(?:length|Count|Length)|\s*[!=]=\s*null)\s*$/;

/**
 * Subjects of an assertion in Rust/Java/C#: every top-level argument that is not a literal, with the leading `&`/`!`
 * and trailing `.unwrap()`, `?`, `.is_ok()`, `.size()`, `!= null` ... stripped, so `assert_eq!(f(x).unwrap(), 1)` and
 * `assert!(f(x).is_ok())` share `f(x)`. Argument order is not fixed across JUnit 4/5, TestNG, xUnit, NUnit and
 * `assert_eq!`, hence a list compared by intersection. Fluent styles carry the subject in the receiver:
 * `assertThat(<here>)`, `Assert.That(<here>, ...)`, `<here>.Should()`, `verify(<mock>).<method>`, `<here>.unwrap()`.
 */
function subjectsOf(lang: Lang, text: string): string[] {
  if (!isAttrLang(lang)) return [subjectOf(lang, text)];
  const squash = (s: string) => s.replace(/\s+/g, '').slice(-60);
  const clean = (arg: string): string => {
    let a = arg.trim().replace(/^(?:&mut\s+|[&!*]\s*)+/, '');
    if (/^matches!\s*\(/.test(a)) a = (splitArgs(a, a.indexOf('('))[0] ?? a).trim(); // matches!(x, Pattern) -> x
    for (let n = 0; n < 4; n++) a = a.replace(WEAK_SUFFIX, '');
    return squash(a);
  };
  const t = text.trim().replace(/^\s*(?:let\s+(?:mut\s+)?|final\s+|var\s+)?(?:[\w:<>\[\],?()]+\s+)?[A-Za-z_]\w*\s*=\s*(?=[^=])/, '');
  let m: RegExpExecArray | null;
  if (lang === 'java' && (m = /\bverify\s*\(([^)]*)\)\s*\.\s*(\w+)/.exec(t))) return [squash(`verify(${m[1]}).${m[2]}`)];
  if (lang === 'csharp' && (m = /^(.*?)\.(?:Verify|Received|DidNotReceive)\s*\(\s*(\w+\s*=>\s*\w+\.\w+)/.exec(t))) return [squash(`${m[1]}.${m[2]}`)];
  if (lang === 'csharp' && (m = /^(.*?)\.Should\s*\(/.exec(t))) return [clean(m[1] as string)];
  if (lang === 'rust' && !/\b(?:assert\w*|panic|matches)!/.test(t) && (m = /^(.*?)\.(?:unwrap\w*|expect\w*|ok)\s*\(/.exec(t))) return [clean(m[1] as string)];
  const re = new RegExp(COUNTERS[lang].assertion.source);
  const a = re.exec(t);
  if (!a || a[0].startsWith('@') || t[a.index + a[0].length - 1] !== '(') return [squash(t)];
  const open = a.index + a[0].length - 1;
  if (a[0].startsWith('.')) return [clean(t.slice(0, a.index))];
  const args = splitArgs(t, open);
  const fluent = /\b(?:assertThat|assertThatThrownBy|assertThatCode|assertThatExceptionOfType|Assert\.That)\s*\($/.test(t.slice(0, open + 1));
  const subjects = (fluent ? args.slice(0, 1) : args).map(clean).filter((s) => s !== '' && !LITERAL_ARG.test(s));
  return subjects.length > 0 ? subjects : [squash(t)];
}

function intersects(a: string[], b: string[]): boolean {
  return a.some((x) => b.includes(x));
}

/** `expect(cfg.name)` and `expect(cfg)` share the root `expect(cfg`; the attribute languages compare whole subjects. */
function subjectRoot(lang: Lang, subject: string): string {
  if (isAttrLang(lang)) return subject;
  const m = /^(expect\([^.)\[]*)/.exec(subject);
  return m ? (m[1] as string) : subject;
}

// --- declaration identity for attribute languages ---------------------------------------------------

/** The method/fn/class name a test attribute applies to (Rust `fn x`, Java/Kotlin/C# method signature, `class X`). */
const SIGNATURE: Record<AttrLang, RegExp> = {
  rust: /\bfn\s+([A-Za-z_]\w*)/,
  java: /^(?:(?:public|private|protected|static|final|synchronized|default|abstract|native|strictfp|open|internal|suspend|override)\s+)*(?:fun\s+(?:`([^`]+)`|([A-Za-z_]\w*))|(?:<[^>]+>\s*)?[\w.<>\[\],?]+\s+([A-Za-z_]\w*)\s*\(|(?:class|interface|object)\s+([A-Za-z_]\w*))/,
  csharp: /^(?:(?:public|private|protected|internal|static|async|override|virtual|new|unsafe|extern|partial|sealed)\s+)*(?:[\w.<>\[\],?()]+\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(|(?:class|record|struct)\s+([A-Za-z_]\w*))/,
};
const ATTR_LINE: Record<AttrLang, RegExp> = { rust: /^#\[/, java: /^@/, csharp: /^\[/ };

function signatureOf(lang: AttrLang, t: string): string | null {
  const m = SIGNATURE[lang].exec(t.trim());
  if (!m) return null;
  return m.slice(1).find(Boolean) ?? null;
}

/** Attribute with its arguments dropped: `#[tokio::test(flavor = ..)]` -> `#[tokio::test]`, `[Fact(Skip = "..")]` -> `[Fact]`. */
function attrHead(lang: AttrLang, t: string): string {
  const m = lang === 'rust' ? /^#\[\s*([\w:]+)/.exec(t) : lang === 'java' ? /^@(\w+)/.exec(t) : /^\[\s*(?:[\w.]+\.)?(\w+)/.exec(t);
  const name = m?.[1] ?? t;
  return lang === 'rust' ? `#[${name}]` : lang === 'java' ? `@${name}` : `[${name}]`;
}

/**
 * The declaration an attribute/annotation line at `idx` belongs to: the signature on the same line or on the first
 * non-attribute line that follows (walking the hunk as the `kind` side of the file reads, skipping the other side),
 * within 8 lines. Null when no signature is found.
 */
function declSignature(lang: AttrLang, lines: DiffLine[], idx: number, kind: '+' | '-'): string | null {
  const own = normalize(lang, (lines[idx] as DiffLine).text).trim();
  const rest = own.replace(/^(?:#\[[^\]]*\]|@\w+(?:\([^)]*\))?|\[[^\]]*\])\s*/, '');
  const same = rest !== '' && !ATTR_LINE[lang].test(rest) ? signatureOf(lang, rest) : null;
  if (same) return same;
  for (let j = idx + 1, seen = 0; j < lines.length && seen < 8; j++) {
    const l = lines[j] as DiffLine;
    if (l.kind !== kind && l.kind !== ' ') continue;
    const t = normalize(lang, l.text).trim();
    if (t === '') continue;
    seen++;
    if (ATTR_LINE[lang].test(t)) continue;
    return signatureOf(lang, t);
  }
  return null;
}

/** Identity of a test declaration: the attribute head plus the signature it applies to (`#[test] fn parses_hours`). */
function declKey(lang: AttrLang, lines: DiffLine[], idx: number, kind: '+' | '-'): string {
  const own = normalize(lang, (lines[idx] as DiffLine).text).trim();
  const sig = declSignature(lang, lines, idx, kind);
  return sig ? `${attrHead(lang, own)} ${sig}` : attrHead(lang, own);
}

/** A skip line with its reason dropped (`#[ignore = ".."]` -> `#[ignore]`, `@Disabled("..")` -> `@Disabled`) plus the declaration it gates. */
function skipKey(lang: AttrLang, lines: DiffLine[], idx: number, kind: '+' | '-'): string {
  const own = normalize(lang, (lines[idx] as DiffLine).text)
    .replace(/\s*=\s*"[^"]*"/g, '')
    .replace(/\(\s*"[^"]*"\s*\)/g, '')
    .replace(/\s+/g, '');
  const sig = declSignature(lang, lines, idx, kind);
  return sig ? `${own} ${sig}` : own;
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

function declarationLines(lang: Lang, lines: DiffLine[], kind: '+' | '-', inRegion: (l: DiffLine) => boolean = () => true): string[] {
  if (lang === 'other') return [];
  const re = new RegExp(COUNTERS[lang].test.source, COUNTERS[lang].test.flags.replace('g', ''));
  if (isAttrLang(lang)) {
    // Every `#[test]` / `@Test` / `[Fact]` line reads the same: the identity is the declaration it applies to.
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] as DiffLine;
      if (l.kind !== kind || !inRegion(l)) continue;
      if (re.test(normalize(lang, l.text).trim())) out.push(declKey(lang, lines, i, kind));
    }
    return out;
  }
  return lines.filter((l) => l.kind === kind).map((l) => normalize(lang, l.text).trim()).filter((t) => re.test(t) && !/\.skip\s*\(|\.only\s*\(/.test(t));
}

/** The first code line (not blank, not an attribute) after `idx` as the `kind` side of the file reads. */
function nextCodeLine(lang: AttrLang, lines: DiffLine[], idx: number, kind: '+' | '-'): string {
  for (let j = idx + 1, seen = 0; j < lines.length && seen < 8; j++) {
    const l = lines[j] as DiffLine;
    if (l.kind !== kind && l.kind !== ' ') continue;
    const t = normalize(lang, l.text).trim();
    if (t === '') continue;
    seen++;
    if (ATTR_LINE[lang].test(t)) continue;
    return t;
  }
  return '';
}

// cfg predicates that state a platform/tool fact (a test ignored under Miri still runs under plain cargo test).
const RUST_PLATFORM_PRED = /^(?:not\(\s*)?(?:miri|debug_assertions|windows|unix|loom|fuzzing|coverage|sanitize|target_(?:os|arch|family|env|pointer_width|vendor|endian|has_atomic|feature)\s*=|panic\s*=)/;
// verified: `all()` with no predicates is true, `any()` false (https://doc.rust-lang.org/reference/conditional-compilation.html);
// unverified: the `true`/`false` literal predicates are recent Rust.
const RUST_ALWAYS_TRUE = /^(?:all\(\s*\)|true|not\(\s*any\(\s*\)\s*\))$/;
const RUST_NEVER_TRUE = /^(?:any\(\s*\)|false|not\(\s*all\(\s*\)\s*\))$/;

/** Severity of a new skip, per language: platform facts are low, conditions medium, unconditional high, a whole class critical. */
function skipSeverity(lang: AttrLang, code: string, lines: DiffLine[], idx: number, beforeText: string | null): [Severity, string] {
  const gatesClass = /\b(?:class|interface|object|record)\s+[A-Za-z_]\w*/.test(nextCodeLine(lang, lines, idx, '+'));
  if (lang === 'rust') {
    const ca = /#\[\s*cfg_attr\s*\((.*?),\s*ignore\s*\)/.exec(code);
    if (ca) {
      const pred = (ca[1] as string).trim();
      if (RUST_ALWAYS_TRUE.test(pred)) return ['critical', `#[cfg_attr(${pred}, ignore)]: the predicate is always true, the test is always ignored`];
      if (RUST_PLATFORM_PRED.test(pred)) return ['low', `test ignored under a platform/tool predicate (${pred}); it still runs under plain cargo test`];
      return ['high', `test ignored when cfg(${pred}) holds`];
    }
    return ['high', '#[ignore] added: cargo test reports the test as ignored, not failed'];
  }
  if (lang === 'java') {
    if (/@(?:Disabled|Ignore)\b(?!(?:If|On|For|In))/.test(code) || /@Test\s*\([^)]*\benabled\s*=\s*false/.test(code) || /\bAssumptions\.abort\s*\(|\bassumeTrue\s*\(\s*false\s*\)|\bassumeFalse\s*\(\s*true\s*\)/.test(code)) {
      return gatesClass ? ['critical', 'whole test class disabled'] : ['high', 'test disabled: the runner reports it as skipped, not failed'];
    }
    if (/\bassum(?:eTrue|eFalse|eThat|eNotNull|eNoException|ingThat)\s*\(/.test(code)) {
      // verified: "a failed assumption results in a test being aborted" (docs.junit.org Assumptions)
      if (/System\.getenv|System\.getProperty|Boolean\.getBoolean|\bgetenv\s*\(/.test(code)) return ['high', 'assumption on an environment variable/system property: the test is aborted (reported skipped) wherever it is not set'];
      return ['medium', 'assumption added: the test is aborted (reported skipped) when it does not hold'];
    }
    if (/@Enabled(?:If|OnOs|OnJre|ForJreRange|IfSystemProperty|IfSystemProperties|IfEnvironmentVariable|IfEnvironmentVariables|InNativeImage)\b/.test(code)) {
      const sig = declSignature(lang, lines, idx, '+');
      const isNew = sig !== null && (beforeText === null || !new RegExp(`\\b${sig}\\s*\\(`).test(beforeText));
      if (isNew) return ['low', 'new test gated behind a positive condition'];
      return ['high', 'positive gate added to an existing test: it only runs when the condition holds (on CI usually never)'];
    }
    if (/@Disabled(?:OnOs|OnJre|ForJreRange|InNativeImage)\b/.test(code)) return ['low', 'test disabled on a platform/JRE; it still runs elsewhere'];
    if (/@Disabled(?:If|IfSystemProperty|IfSystemProperties|IfEnvironmentVariable|IfEnvironmentVariables)\b/.test(code)) return ['medium', 'test disabled behind a condition'];
    return ['high', 'test skipped'];
  }
  if (/\bAssume\.That\s*\(|\bAssert\.Skip(?:When|Unless)\s*\(|\bSkip(?:When|Unless)\s*=/.test(code)) return ['medium', 'conditional skip added: the test is skipped when the condition holds'];
  if (/\[\s*Explicit\b|\bExplicit\s*=\s*true/.test(code)) return ['high', '[Explicit] added: the test does not run unless explicitly selected'];
  return gatesClass ? ['critical', 'whole test class ignored'] : ['high', 'test skipped or ignored: the runner reports it as skipped, not failed'];
}

/** `#[should_panic]` / assertThrows(AssertionError) / Assert.Throws<XunitException> around a body that asserts: its own failure satisfies the test. */
const OWN_FAILURE: Record<AttrLang, RegExp> = {
  rust: /^\s*#\[\s*should_panic\s*\]/,
  java: /\bassertThrows(?:Exactly)?\s*\(\s*(?:AssertionError|AssertionFailedError|Throwable|Error)\.class|@Test\s*\([^)]*\bexpected\s*=\s*(?:AssertionError|Throwable|Error)\.class/,
  csharp: /\bAssert\.(?:Throws|ThrowsAny|ThrowsAsync|ThrowsAnyAsync|ThrowsException|ThrowsExactly)<(?:XunitException|AssertionException|AssertFailedException|Exception|SystemException)>\s*\(|\bThrows\.(?:InstanceOf|TypeOf)<(?:Exception|AssertionException|XunitException)>|\bThrows\.Exception\b/,
};
const STRICT_ASSERT: Record<AttrLang, RegExp> = {
  rust: /\b(?:debug_)?assert(?:_eq|_ne|_matches)?!\s*\(/g,
  java: /\bassert(?!Throws|ThatThrownBy|ThatExceptionOfType|ThatCode)\w*\s*\(|\bfail\s*\(/g,
  csharp: /\bAssert\.(?!Throws|ThrowsAny|ThrowsAsync|ThrowsException|ThrowsExactly|That\s*\([^,]*,\s*Throws)\w+|\.Should\s*\(\s*\)\.(?!Throw)/g,
};

/** The body a `#[should_panic]`/`@Test(expected=)` line (attribute) or an assertThrows/Assert.Throws call wraps, as the new file reads. */
function wrappedBody(lang: AttrLang, lines: DiffLine[], idx: number, attribute: boolean): string {
  const out: string[] = [];
  if (attribute) {
    let sigIndent = -1;
    for (let j = idx + 1, seen = 0; j < lines.length && seen < 60; j++) {
      const l = lines[j] as DiffLine;
      if (l.kind === '-') continue;
      const t = normalize(lang, l.text);
      if (t.trim() === '') continue;
      seen++;
      if (sigIndent < 0) {
        if (ATTR_LINE[lang].test(t.trim())) continue;
        sigIndent = indentOf(l.text);
        continue;
      }
      if (/^\s*\}/.test(t) && indentOf(l.text) <= sigIndent) break;
      out.push(t);
    }
    return out.join('\n');
  }
  const own = normalize(lang, (lines[idx] as DiffLine).text);
  const m = OWN_FAILURE[lang].exec(own);
  out.push(own.slice(m ? m.index + m[0].length : 0));
  if (!/\{\s*$/.test(own)) return out.join('\n');
  for (let j = idx + 1, seen = 0; j < lines.length && seen < 16; j++) {
    const l = lines[j] as DiffLine;
    if (l.kind === '-') continue;
    const t = normalize(lang, l.text);
    seen++;
    if (/^\s*\}\s*\)/.test(t)) break;
    out.push(t);
  }
  return out.join('\n');
}

/** `let n = 4;` / `int n = 4;` / `var n = 4;` for the subject of an assertion added in the same change. */
const CONST_DECL: Record<AttrLang, (name: string) => RegExp> = {
  rust: (n) => new RegExp(`\\blet\\s+(?:mut\\s+)?${n}(?:\\s*:\\s*[^=]+)?\\s*=\\s*(?:-?[\\d.]+(?:_?[iuf]\\d+)?|true|false|"|vec!\\[\\s*\\]|Vec::new\\(\\)|None|String::new\\(\\))\\s*;`),
  java: (n) => new RegExp(`\\b(?:int|long|short|byte|double|float|boolean|char|String|var|val|Integer|Long|Double|Boolean|final\\s+\\w+)\\s+${n}\\s*(?::\\s*\\w+\\s*)?=\\s*(?:-?[\\d.]+[LlFfDd]?|true|false|null|"|List\\.of\\(\\)|Map\\.of\\(\\)|Set\\.of\\(\\))\\s*;?\\s*$`),
  csharp: (n) => new RegExp(`\\b(?:var|int|long|short|byte|double|float|bool|string|decimal|char)\\s+${n}\\s*=\\s*(?:-?[\\d.]+[mMfFdDL]?|true|false|null|"|\\[\\s*\\]|new\\s*\\(\\s*\\))\\s*;`),
};
const HELPER_DECL: Record<AttrLang, RegExp> = {
  rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/,
  java: /^\s*(?:(?:public|private|protected|static|final|synchronized|default|internal|open)\s+)*(?:<[^>]+>\s*)?(?:fun\s+([A-Za-z_]\w*)\s*\(|[\w.<>\[\],?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\{?\s*$)/,
  csharp: /^\s*(?:(?:public|private|protected|internal|static|async|override|virtual)\s+)*[\w.<>\[\],?()]+\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*\{?\s*$/,
};
const KEYWORD_NAME = /^(?:if|for|while|switch|catch|return|new|else|using|lock|foreach|throw|do|try|match|loop)$/;

function scanTestFile(ctx: Ctx, opts: ScanOptions, cross: CrossFile, movedPair: boolean): void {
  const { file, lang } = ctx;
  if (file.status === 'deleted') {
    if (!movedPair) add(ctx, 'test-file-deleted', 'high', null, 'test file deleted', file.path, null);
    return;
  }
  // Path rules only: a Rust inline module or a C# class keeps its attributes wherever it goes, but the runner's
  // locations are what matter here.
  if (file.oldPath && isTestFile(file.oldPath) && !isTestFile(file.path)) {
    add(ctx, 'test-file-deleted', 'high', null, `test file moved out of the test locations (${file.oldPath} -> ${file.path}); the runner will no longer collect it`, file.path, null);
    return;
  }
  if (lang === 'java' && file.oldPath && /\.java$/.test(file.path)) {
    const name = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;
    if (MAVEN_TEST_NAME.test(name(file.oldPath)) && !MAVEN_TEST_NAME.test(name(file.path))) {
      // Maven compiles every class under src/test but only runs the Surefire/Failsafe names; Gradle scans for @Test.
      const maven = opts.readAfter('pom.xml') !== null;
      add(ctx, 'test-file-deleted', maven ? 'high' : 'medium', null, `renamed to a name Surefire/Failsafe do not collect by default (${file.oldPath} -> ${file.path}); Maven compiles it but never runs it`, file.path, null);
    }
  }
  const beforeText = file.status === 'added' ? null : opts.readBefore(file.oldPath ?? file.path);
  const afterText = opts.readAfter(file.path);
  const before = countTests(lang, beforeText);
  const after = countTests(lang, afterText);
  // Rust: every detector is confined to the #[cfg(test)] regions of a source file (null = the whole file).
  const beforeLines = lang === 'rust' && beforeText ? regionLines(beforeText, rustTestRegions(normalizeFile(lang, beforeText))) : null;
  const afterLines = lang === 'rust' && afterText ? regionLines(afterText, rustTestRegions(normalizeFile(lang, afterText))) : null;
  const inRegion = (l: DiffLine): boolean => (l.kind === '-' ? beforeLines === null || (l.oldNo !== null && beforeLines.has(l.oldNo)) : afterLines === null || (l.newNo !== null && afterLines.has(l.newNo)));
  const allLines = file.hunks.flatMap((h) => h.lines);
  const allRemoved = allLines.filter((l) => l.kind === '-' && inRegion(l));
  const allAdded = allLines.filter((l) => l.kind === '+' && inRegion(l));
  const addedNorm = allAdded.map((l) => normalize(lang, l.text));
  const addedText = addedNorm.join('\n');
  const assertRe = lang === 'other' ? null : COUNTERS[lang].assertion;

  for (const hunk of file.hunks) {
    const removed = hunk.lines.filter((l) => l.kind === '-' && inRegion(l));
    const added = hunk.lines.filter((l) => l.kind === '+' && inRegion(l));
    const inComment = insideBlockComment(lang, hunk.lines);
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i] as DiffLine;
      if (line.kind !== '+') continue;
      if (inComment[i] || !inRegion(line)) continue;
      const code = normalize(lang, line.text);
      if (code.trim() === '') continue;
      const sup = suppression(hunk.lines, i);

      if (lang === 'js' && JS_ONLY.test(code)) add(ctx, 'only-added', 'critical', line, '`.only` added: every other test in the file is silently skipped', line.text, sup);

      const skipRe = lang === 'other' ? null : COUNTERS[lang].skip;
      if (skipRe && count(skipRe, code) > 0) {
        // A skip that merely moved (identical line removed anywhere in the file) is not new. Attribute languages compare
        // the skip with its reason dropped plus the declaration it gates, since `#[ignore]` reads the same on every test.
        const moved = isAttrLang(lang)
          ? ((): boolean => {
              const key = skipKey(lang, hunk.lines, i, '+');
              return allLines.some((r, ri) => r.kind === '-' && count(skipRe, normalize(lang, r.text)) > 0 && skipKey(lang, allLines, ri, '-') === key);
            })()
          : allRemoved.some((r) => stripComment(lang, r.text).trim() === stripComment(lang, line.text).trim());
        if (!moved) {
          const [severity, why] = isAttrLang(lang) ? skipSeverity(lang, code, hunk.lines, i, beforeText) : ['high' as Severity, 'test skipped or marked expected-failure'];
          add(ctx, 'skip-added', severity, line, why, line.text, sup);
        }
      }
      if (lang === 'rust') {
        // A #[cfg(P)] gate newly added directly above a test fn: any() never compiles it, a feature gate hides it from a plain run.
        const cfg = /^\s*#\[\s*cfg\s*\((.*)\)\s*\]\s*$/.exec(code);
        const next = cfg ? nextCodeLine(lang, hunk.lines, i, '+') : '';
        if (cfg && /^\s*(?:pub\s+)?(?:async\s+)?fn\s+/.test(next) && !/^\s*(?:all|any)?\(?\s*test\b/.test(cfg[1] as string)) {
          const key = skipKey(lang, hunk.lines, i, '+');
          const moved = allLines.some((r, ri) => r.kind === '-' && /^\s*#\[\s*cfg\s*\(/.test(normalize(lang, r.text)) && skipKey(lang, allLines, ri, '-') === key);
          const pred = (cfg[1] as string).trim();
          if (!moved) {
            const severity: Severity = RUST_NEVER_TRUE.test(pred) ? 'critical' : RUST_PLATFORM_PRED.test(pred) ? 'low' : 'high';
            add(ctx, 'skip-added', severity, line, severity === 'critical' ? `#[cfg(${pred})] never compiles the test below it` : `test compiled only when cfg(${pred})`, line.text, sup);
          }
        }
      }
      if (lang === 'js' && JS_TODO.test(code)) {
        const title = titleOf(line.text);
        const wasReal = title !== null && removed.some((r) => /\b(?:it|test|specify)\s*\(/.test(normalize('js', r.text)) && titleOf(r.text) === title);
        if (wasReal) add(ctx, 'skip-added', 'high', line, 'existing test turned into a todo placeholder', line.text, sup);
        else add(ctx, 'todo-added', 'low', line, 'todo placeholder added (not a real test)', line.text, sup);
      }

      const taut = lang === 'other' ? null : TAUTOLOGY[lang];
      const tautRaw = TAUTOLOGY_RAW[lang];
      if ((taut && taut.test(code)) || (tautRaw && tautRaw.test(stripComment(lang, line.text)))) add(ctx, 'tautology-added', 'high', line, 'assertion that can never fail', line.text, sup);

      if (lang === 'js') {
        // expect.assertions(0), or a lowered count, lets a test pass when its assertions never run.
        const ea = /\bexpect\.assertions\s*\(\s*(\d+)\s*\)/.exec(code);
        if (ea) {
          const prev = removed.map((r) => /\bexpect\.assertions\s*\(\s*(\d+)\s*\)/.exec(normalize('js', r.text))).find(Boolean);
          const n = Number(ea[1]);
          if (n === 0) add(ctx, 'assertion-weakened', 'high', line, 'expect.assertions(0): the test passes even if no assertion runs', line.text, sup);
          else if (prev && n < Number(prev[1])) add(ctx, 'assertion-weakened', 'medium', line, `expect.assertions lowered ${prev[1]} -> ${n}`, line.text, sup);
        }
        // An assertion whose subject is a constant introduced by the same change: expect(total).toBe(42) after `const total = 42`.
        const subj = /\bexpect\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.(?:not\.)?to\w+\s*\(/.exec(code)?.[1];
        if (subj) {
          const esc = subj.replace(/\$/g, '\\$');
          const constRe = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*(?:-?[\\d.]+|true|false|null|["'\`]|\\[\\s*\\]|\\{\\s*\\})`);
          // A counter or accumulator (calls++, total += x, seen.push(...)) is not a constant.
          const mutRe = new RegExp(`\\b${esc}\\s*(?:\\+\\+|--|[-+*/%]=)|\\b${esc}\\.(?:push|add|set|splice|unshift)\\s*\\(`);
          const isConst = added.some((a) => a !== line && constRe.test(normalize('js', a.text))) && !added.some((a) => mutRe.test(normalize('js', a.text)));
          if (isConst) add(ctx, 'tautology-added', 'high', line, `expect(${subj}) tests a constant assigned in the same change, not the code under test`, line.text, sup);
        }
      }
      if (isAttrLang(lang) && assertRe && count(assertRe, code) > 0 && !skipRe?.test(code)) {
        // The same constant-subject check: assert_eq!(n, 4) / assertEquals(4, n) / Assert.Equal(4, n) after `n = 4` in the same change.
        const subs = subjectsOf(lang, stripComment(lang, line.text));
        if (subs.length > 0 && subs.every((s) => /^[A-Za-z_]\w*$/.test(s))) {
          const isConst = subs.every((name) => {
            const constRe = CONST_DECL[lang](name);
            const mutRe = new RegExp(`(?:^|[^\\w.])${name}\\s*(?:\\+\\+|--|[-+*/%]=|=(?!=))|\\b${name}\\.(?:push|push_str|insert|extend|add|set|Add|Insert|Append|put)\\s*\\(`);
            return added.some((a) => a !== line && constRe.test(normalize(lang, a.text))) && !added.some((a) => a !== line && !constRe.test(normalize(lang, a.text)) && mutRe.test(normalize(lang, a.text)));
          });
          if (isConst) add(ctx, 'tautology-added', 'high', line, `assertion on ${subs.join(', ')}: a constant assigned in the same change, not the code under test`, line.text, sup);
        }
      }
      if (isAttrLang(lang)) {
        // A test that expects its own assertion failure: #[should_panic] over assert!, assertThrows(AssertionError, () -> assertEquals(..)),
        // Assert.Throws<XunitException>(() => Assert.Equal(..)). A genuine "this panics/throws" body has no assertion and is not reported.
        const own = OWN_FAILURE[lang].exec(code);
        if (own) {
          const attribute = lang === 'rust' || own[0].startsWith('@');
          const moved = attribute && allLines.some((r, ri) => r.kind === '-' && OWN_FAILURE[lang].test(normalize(lang, r.text)) && skipKey(lang, allLines, ri, '-') === skipKey(lang, hunk.lines, i, '+'));
          if (!moved && count(STRICT_ASSERT[lang], wrappedBody(lang, hunk.lines, i, attribute)) > 0) {
            add(ctx, 'assertion-weakened', 'high', line, lang === 'rust' ? '#[should_panic] added over a body that asserts: the assertion failure now satisfies the attribute' : 'the test expects the assertion exception itself: a failing assertion now passes', line.text, sup);
          }
        }
      }

      if (EARLY_RETURN.test(code)) {
        // A bare return, or a return inside an `if ... {` / `if ...:` block added just above it: the reference
        // indentation is the if's, and the block's closing brace is skipped, so assertions after the block count.
        let indent = indentOf(line.text);
        let prevIdx = i - 1;
        while (prevIdx >= 0 && ((hunk.lines[prevIdx] as DiffLine).kind === '-' || normalize(lang, (hunk.lines[prevIdx] as DiffLine).text).trim() === '')) prevIdx--;
        const prev = prevIdx >= 0 ? (hunk.lines[prevIdx] as DiffLine) : null;
        const guarded = !/\bif\b/.test(code) && prev !== null && prev.kind === '+' && /^\s*(?:if|elif|else if)\b.*(?:\{|:)\s*$/.test(normalize(lang, prev.text)) && indentOf(prev.text) < indent;
        if (guarded && prev) indent = indentOf(prev.text);
        let shadowed = false;
        for (let j = i + 1; j < Math.min(hunk.lines.length, i + 24); j++) {
          const next = hunk.lines[j] as DiffLine;
          if (next.kind === '-') continue;
          const t = normalize(lang, next.text);
          if (t.trim() === '') continue;
          if (guarded && /^\s*\}\s*$/.test(t) && indentOf(next.text) === indent) continue; // the if-block's closing brace
          if (indentOf(next.text) < indent || (lang !== 'py' && /^\s*\}/.test(t) && indentOf(next.text) <= indent)) break;
          if (assertRe && count(assertRe, t) > 0) {
            shadowed = true;
            break;
          }
        }
        if (shadowed) {
          const what = /\bAssert\.Pass\b/.test(code) ? 'Assert.Pass() added before the assertions; the test ends there as a success' : `return added before the assertions${guarded ? ' (behind a condition)' : ''}; the rest of the test never runs`;
          add(ctx, 'early-return-added', 'high', line, what, line.text, sup);
        }
      }

      for (const d of DOWNGRADES) {
        if (d.lang ? d.lang !== lang : isAttrLang(lang)) continue;
        if (!d.to.test(code)) continue;
        if (d.attr && isAttrLang(lang)) {
          // The subject is the declaration the attribute applies to.
          const sig = declSignature(lang, hunk.lines, i, '+');
          const strongIdx = sig === null ? -1 : hunk.lines.findIndex((r, ri) => r.kind === '-' && d.from.test(normalize(lang, r.text)) && declSignature(lang, hunk.lines, ri, '-') === sig);
          if (strongIdx < 0) continue;
          if (hunk.lines.some((a, ai) => a.kind === '+' && a !== line && d.from.test(normalize(lang, a.text)) && declSignature(lang, hunk.lines, ai, '+') === sig)) continue;
          add(ctx, 'assertion-weakened', 'medium', line, `assertion weakened: ${d.what}`, `- ${(hunk.lines[strongIdx] as DiffLine).text.trim()}\n+ ${line.text.trim()}`, sup);
          continue;
        }
        // Subjects are compared with string literals intact: f("a") and f("b") are different values.
        const rawSubject = (t: string) => subjectsOf(lang, stripComment(lang, t));
        const subj = rawSubject(line.text);
        const strong = removed.find((r) => d.from.test(normalize(lang, r.text)) && intersects(rawSubject(r.text), subj));
        if (!strong) continue;
        // The strong assertion is still there (re-indented / reformatted): not a downgrade.
        if (added.some((a) => a !== line && d.from.test(normalize(lang, a.text)) && intersects(rawSubject(a.text), subj))) continue;
        // Existence check next to stronger assertions on the same value (snapshot -> explicit fields): not a downgrade.
        if (d.existence) {
          const roots = subj.map((s) => subjectRoot(lang, s));
          const stronger = added.filter((a) => a !== line && STRONG_MATCHER[lang].test(normalize(lang, a.text)) && intersects(rawSubject(a.text).map((s) => subjectRoot(lang, s)), roots));
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
      if (isAttrLang(lang)) {
        for (const t of TOLERANCES) {
          if (t.lang !== lang) continue;
          const now = toleranceOf(t, code);
          if (now === null) continue;
          const prev = removed.map((r) => toleranceOf(t, normalize(lang, r.text))).find((v) => v !== null);
          if (prev === null || prev === undefined) continue;
          if (t.kind === 'digits' ? now < prev : now > prev) add(ctx, 'tolerance-widened', toleranceSeverity(t.kind, prev, now), line, `${t.what} ${prev} -> ${now}`, line.text, sup);
        }
      }

      // Swallowed errors: an added catch/except with an empty body, a recover() in Go, a discarded catch_unwind in Rust.
      if ((lang === 'js' || lang === 'java' || lang === 'csharp') && /\bcatch\b/.test(code)) {
        const body = hunk.lines.slice(i + 1, i + 4).filter((l) => l.kind === '+').map((l) => normalize(lang, l.text).trim());
        const allman = lang !== 'js' && body[0] === '{' && body[1] === '}'; // C#/Java brace on its own line
        if (/\bcatch\b[^{]*\{\s*\}\s*$/.test(code) || (body.length > 0 && body[0] === '}') || allman) {
          const assertion = lang === 'java' ? /\bcatch\s*\(\s*(?:final\s+)?(?:AssertionError|AssertionFailedError|Throwable|Error)\b/.test(code) : lang === 'csharp' ? /\bcatch\s*\(\s*(?:XunitException|AssertionException|AssertFailedException|Exception)\b/.test(code) : false;
          if (assertion) add(ctx, 'error-swallowed', 'high', line, 'empty catch of the assertion exception: a failing assertion is discarded and the test passes', line.text, sup);
          else add(ctx, 'error-swallowed', 'medium', line, 'empty catch block added in a test', line.text, sup);
        }
      }
      if (lang === 'py' && /^\s*except\b[^:]*:\s*(?:pass|\.\.\.)?\s*$/.test(code)) {
        const next = hunk.lines.slice(i + 1, i + 3).filter((l) => l.kind === '+').map((l) => normalize('py', l.text).trim())[0];
        if (/^\s*except\b[^:]*:\s*(?:pass|\.\.\.)\s*$/.test(code) || next === 'pass' || next === '...') add(ctx, 'error-swallowed', 'medium', line, 'except ... pass added in a test', line.text, sup);
      }
      if (lang === 'go' && /\bdefer\s+func\s*\(\s*\)\s*\{[^}]*\brecover\s*\(\s*\)/.test(code)) add(ctx, 'error-swallowed', 'medium', line, 'recover() added in a test; panics are hidden', line.text, sup);
      if (lang === 'rust') {
        if (/^\s*let\s+_\s*=\s*(?:std::)?panic::catch_unwind\s*\(|^\s*(?:std::)?panic::catch_unwind\s*\(.*\)\s*;\s*$/.test(code)) add(ctx, 'error-swallowed', 'high', line, 'catch_unwind with the result discarded: a panic (a failed assertion) no longer fails the test', line.text, sup);
        else if (/\b(?:Err\(\s*_?\w*\s*\)|None)\s*=>\s*(?:\{\s*\}|\(\))\s*,?\s*$/.test(code)) add(ctx, 'error-swallowed', 'medium', line, 'Err/None match arm that does nothing: that path passes silently', line.text, sup);
      }
    }
  }

  if (file.status === 'added') return;

  if (lang === 'rust') {
    // The gate lives outside the test code: `#[cfg(test)]` replaced by a narrower predicate, or `mod tests;` detached.
    const isGate = (t: string) => /^\s*#\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*$/.test(t);
    let spare = allLines.filter((l) => l.kind === '+' && isGate(normalize(lang, l.text))).length; // gates that merely moved
    for (const hunk of file.hunks) {
      const replacements = hunk.lines.filter((l) => l.kind === '+' && /^\s*#\[\s*cfg\s*\(/.test(normalize(lang, l.text)) && !isGate(normalize(lang, l.text)));
      for (let i = 0; i < hunk.lines.length; i++) {
        const l = hunk.lines[i] as DiffLine;
        if (l.kind !== '-' || !isGate(normalize(lang, l.text))) continue;
        if (spare > 0) {
          spare--;
          continue;
        }
        const near = hunk.lines.slice(i + 1, i + 6).find((a) => replacements.includes(a));
        const repl = near ?? replacements.find((a) => /\btest\b|any\(\s*\)|\bfalse\b/.test(normalize(lang, a.text)));
        if (!repl) continue; // gate dropped entirely: the module now always compiles and the tests still run
        replacements.splice(replacements.indexOf(repl), 1);
        const pred = (/#\[\s*cfg\s*\((.*)\)\s*\]/.exec(normalize(lang, repl.text))?.[1] ?? '').trim();
        const severity: Severity = RUST_NEVER_TRUE.test(pred) ? 'critical' : 'high';
        add(ctx, 'skip-added', severity, repl, `test module gate changed: #[cfg(test)] -> ${repl.text.trim()}; a plain cargo test no longer compiles these tests`, `- ${l.text.trim()}\n+ ${repl.text.trim()}`, suppression(hunk.lines, hunk.lines.indexOf(repl)));
      }
    }
    for (const l of allLines) {
      if (l.kind !== '-') continue;
      const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(tests?|test_\w+|\w+_tests?)\s*;/.exec(normalize(lang, l.text));
      if (!m) continue;
      const name = m[1] as string;
      if (allLines.some((a) => a.kind === '+' && new RegExp(`\\bmod\\s+${name}\\b`).test(normalize(lang, a.text)))) continue;
      add(ctx, 'skip-added', 'high', l, `\`mod ${name};\` removed: the test module is no longer compiled or run`, l.text, null);
    }
  }

  // A row dropped from a table-driven test (Go struct literal, .each array row, parametrize tuple, Rust tuple row,
  // Java @CsvSource string, C# [InlineData]) removes a case without touching any test function or assertion.
  const ROW =
    lang === 'go'
      ? /^\s*\{.*\},?\s*$/
      : lang === 'py'
        ? /^\s*\(.*\),?\s*$/
        : lang === 'rust'
          ? /^\s*(?:\(.*\)|\[.*\]|\w+\s*\{.*\}|#\[\s*(?:case|test_case)\b.*)\s*,?\s*$/
          : lang === 'java'
            ? /^\s*(?:"(?:[^"\\]|\\.)*"|Arguments\.of\s*\(.*\)|arguments\s*\(.*\)|\{.*\})\s*,?\s*$/
            : lang === 'csharp'
              ? /^\s*(?:\[\s*(?:InlineData|TestCase|DataRow)\b.*\]|new\s+object\[\]\s*\{.*\}|yield\s+return\s+.*)\s*,?;?\s*$/
              : /^\s*\[.*\],?\s*$/;
  const rowKey = (t: string) => stripComment(lang, t).replace(/\s+/g, '').replace(/,$/, '');
  const removedRows = allRemoved.map((l) => l.text).filter((t) => ROW.test(stripComment(lang, t)) && /["'`]|\d/.test(t));
  const addedRowKeys = new Set(allAdded.map((l) => l.text).filter((t) => ROW.test(stripComment(lang, t))).map(rowKey));
  const droppedRows = removedRows.filter((t) => !addedRowKeys.has(rowKey(t)));
  if (droppedRows.length > 0 && droppedRows.length > allAdded.filter((l) => ROW.test(stripComment(lang, l.text))).length - (removedRows.length - droppedRows.length)) {
    const first = allRemoved.find((l) => l.text === droppedRows[0]);
    add(ctx, 'test-case-removed', 'medium', first ?? null, `${droppedRows.length} row${droppedRows.length === 1 ? '' : 's'} removed from a table-driven test`, droppedRows.slice(0, 2).map((t) => t.trim()).join('\n'), first ? suppression(allLines, allLines.indexOf(first)) : null);
  }

  // Tests removed: reconcile with tests that moved to another file in the same diff.
  const removedDecls = declarationLines(lang, allLines, '-', inRegion);
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
    const testRe = lang === 'other' ? null : new RegExp(COUNTERS[lang].test.source, COUNTERS[lang].test.flags.replace('g', ''));
    let helperCalls = 0;
    for (let k = 0; k < addedNorm.length; k++) {
      const m = isAttrLang(lang) ? HELPER_DECL[lang].exec(addedNorm[k] as string) : helper.exec(addedNorm[k] as string);
      const name = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
      if (!name || /^(?:test|it|describe)$/i.test(name) || KEYWORD_NAME.test(name) || !assertRe) continue;
      // A test declaration (attribute on the line above) is not a helper.
      if (isAttrLang(lang) && testRe) {
        let p = k - 1;
        while (p >= 0 && (addedNorm[p] as string).trim() === '') p--;
        if (p >= 0 && testRe.test((addedNorm[p] as string).trim())) continue;
      }
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

/**
 * Commands that actually run tests (lint/typecheck are deliberately not here). Maven `package`/`install` run Surefire
 * unless `-DskipTests`/`-Dmaven.test.skip=true` is on the same line (verified: surefire skipping-tests page); Gradle
 * `build` depends on `check` which depends on `test` unless `-x test` excludes it (verified: gradle java_testing).
 */
const TEST_ONLY =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:\w+|e2e)\b|\b(?:npx\s+)?(?:vitest|jest|mocha|ava|tap|node\s+--test|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+(?:test|nextest|llvm-cov|miri\s+test)|dotnet\s+test|vstest\.console|make\s+(?:test|tests|check)|tox|nox|rspec|phpunit)\b|\bmvnw?\b(?![^\n]*(?:-DskipTests\b(?!=false)|-Dmaven\.test\.skip=true))[^\n]*\b(?:test|verify|integration-test|install|package|deploy)\b|\bgradlew?\b(?![^\n]*(?:-x\s+(?:test|check)\b|--exclude-task\s+(?:test|check)\b))[^\n]*\b(?:test|check|build|integrationTest|allTests|jvmTest|testDebugUnitTest|connectedAndroidTest)\b/;
const TEST_SCRIPT_KEY = /"(?:test|tests|test:\w+|pretest|posttest|ci|check|verify|e2e)"\s*:/;
const BENIGN_IGNORE = /^\s*['"`]?(?:\*\*\/)?\/?(?:node_modules|dist|build|coverage|\.next|\.nuxt|out|lib|\.git|\.cache|vendor|target|bin|obj|\.gradle|\.idea|__pycache__|\.venv|venv)(?:\/\*\*)?\/?\**['"`]?\s*$/;
// Surefire excludes that hand integration tests to Failsafe, abstract base classes and inner classes are idiom, not sabotage.
const BENIGN_JVM_EXCLUDE = /^\s*['"]?\*\*\/(?:\*IT\.java|IT\*\.java|\*ITCase\.java|\*IT\*|Abstract\*(?:\.java|\.class)?|\*\$\*(?:\.java|\.class)?)['"]?\s*$/;
const BENIGN_PLUGINS = /-p\s+no:(?:cacheprovider|warnings|randomly|cov|faulthandler|logging|xdist)\b/;
const MAVEN_SKIP = /-DskipTests\b(?!=false)|-Dmaven\.test\.skip=true|-DskipITs\b/;
const GRADLE_EXCLUDE = /\bgradlew?\b[^\n]*\s(?:-x|--exclude-task)\s+(?:test|check)\b/;
const GRADLE_FILE = /(?:build|settings)\.gradle(?:\.kts)?$|gradle\.properties$/;
const DOTNET_PROJ = /\.(?:cs|fs|vb)proj$|Directory\.Build\.(?:props|targets)$/;

const CONFIG_SABOTAGE: Array<{ re: RegExp; severity: Severity; message: string; only?: RegExp; id?: string }> = [
  { re: /testPathIgnorePatterns|testIgnore|ignorePatterns\s*[:=]|modulePathIgnorePatterns/, severity: 'critical', message: 'test ignore pattern added', id: 'ignore' },
  { re: /\b(?:testMatch|testRegex|include|spec)\s*[:=]/, severity: 'high', message: 'test file selection narrowed or changed', only: /(?:jest|vitest|vite|playwright|cypress|karma|mocha|ava)\.config|\.mocharc|jest\.config\.json/, id: 'selection' },
  { re: /\b(?:exclude|ignore)\s*[:=]\s*\[/, severity: 'high', message: 'test exclude list changed', only: /(?:vitest|vite|playwright)\.config|\.mocharc/, id: 'ignore' },
  { re: /--passWithNoTests|passWithNoTests\s*[:=]\s*true/, severity: 'critical', message: 'passWithNoTests: a suite with zero tests is reported green' },
  { re: /--testPathPattern[=\s]|--testNamePattern[=\s]|\s-t\s+\\?["']|\s--grep[=\s]|\s-g\s+\\?["']|go\s+test\b.*(?:\s-run\s+\S+|\s-short\b)|\bpytest\b.*\s-k\s+\\?["']?(?!not\b)\w/, severity: 'high', message: 'test selection narrowed on the command line' },
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
  // Cargo.toml (verified: https://doc.rust-lang.org/cargo/reference/cargo-targets.html, /reference/profiles.html)
  { re: /^\s*test\s*=\s*false\b/, severity: 'high', message: 'target excluded from cargo test (test = false)', only: /Cargo\.toml$/ },
  { re: /^\s*autotests\s*=\s*false\b/, severity: 'high', message: 'tests/ discovery disabled (autotests = false)', only: /Cargo\.toml$/ },
  { re: /^\s*harness\s*=\s*false\b/, severity: 'medium', message: 'custom test harness: libtest no longer runs #[test] fns for this target', only: /Cargo\.toml$/ },
  { re: /^\s*doctest\s*=\s*false\b/, severity: 'low', message: 'doctests disabled', only: /Cargo\.toml$/ },
  { re: /^\s*required-features\s*=/, severity: 'medium', message: 'target skipped unless the feature is enabled (required-features)', only: /Cargo\.toml$/ },
  { re: /^\s*(?:debug-assertions|overflow-checks)\s*=\s*false\b/, severity: 'medium', message: 'debug_assert!/overflow panics disabled for tests (the test profile inherits dev)', only: /Cargo\.toml$/ },
  { re: /^\s*(?:exclude|default-members)\s*=\s*\[/, severity: 'medium', message: 'workspace members excluded from cargo test --workspace', only: /Cargo\.toml$/ },
  // .cargo/config.toml (verified: https://doc.rust-lang.org/cargo/reference/config.html: test binaries are executed by the runner)
  { re: /^\s*runner\s*=\s*["'](?:true|:|echo|\/bin\/true)\b/, severity: 'critical', message: 'test runner replaced by a no-op: every test binary "passes" without running', only: /\.cargo\/config(?:\.toml)?$/ },
  { re: /^\s*runner\s*=/, severity: 'low', message: 'cargo test runner changed', only: /\.cargo\/config(?:\.toml)?$/ },
  { re: /^\s*\w+\s*=\s*["'[].*\btest\b.*(?:--skip|--ignored|--exact|--no-run)/, severity: 'medium', message: 'cargo alias narrows or skips tests', only: /\.cargo\/config(?:\.toml)?$/ },
  { re: /^\s*rustflags\s*=.*--cfg\b/, severity: 'low', message: 'rustflags --cfg changed', only: /\.cargo\/config(?:\.toml)?$/ },
  // nextest (verified: https://nexte.st/docs/running/, /docs/configuration/)
  { re: /^\s*default-filter\s*=/, severity: 'high', message: 'nextest default-filter restricts which tests run by default', only: /nextest\.toml$/ },
  { re: /^\s*retries\s*=\s*[1-9]/, severity: 'medium', message: 'nextest retries: flaky tests pass on retry', only: /nextest\.toml$/ },
  // pom.xml (verified: surefire skipping-tests, inclusion-exclusion, test-mojo, rerun-failing-tests pages)
  { re: /<(?:skipTests|maven\.test\.skip|skipITs)>\s*true\s*</, severity: 'critical', message: 'Maven tests skipped (skipTests/maven.test.skip/skipITs)', only: /pom\.xml$/ },
  { re: /<(?:testFailureIgnore|maven\.test\.failure\.ignore)>\s*true\s*</, severity: 'critical', message: 'Maven test failures ignored (testFailureIgnore): the build is green with failing tests', only: /pom\.xml$/ },
  { re: /<skip>\s*true\s*</, severity: 'medium', message: 'a Maven plugin execution is skipped (<skip>true</skip>)', only: /pom\.xml$/ },
  { re: /<exclude>/, severity: 'high', message: 'Surefire/Failsafe exclude added', only: /pom\.xml$/, id: 'xml-exclude' },
  { re: /<include>/, severity: 'medium', message: 'Surefire/Failsafe include list changed: only matching classes run', only: /pom\.xml$/ },
  { re: /<test>[^<]/, severity: 'high', message: 'Surefire <test> runs a single test', only: /pom\.xml$/ },
  { re: /<(?:excludedGroups|groups)>/, severity: 'medium', message: 'test groups filtered', only: /pom\.xml$/ },
  { re: /<rerunFailingTestsCount>\s*[1-9]/, severity: 'medium', message: 'failing tests re-run: flakes are reported green', only: /pom\.xml$/ },
  { re: /<failIfNoSpecifiedTests>\s*false|<testSourceDirectory>/, severity: 'medium', message: 'Surefire discovery configuration changed', only: /pom\.xml$/ },
  { re: /<exclude\s+name\s*=/, severity: 'high', message: 'TestNG exclude added', only: /testng\.xml$/ },
  // Maven command lines (CI, Makefile, .mvn/maven.config: one option per line; verified: https://maven.apache.org/configure.html)
  { re: /-Dmaven\.test\.failure\.ignore=true\b/, severity: 'critical', message: 'Maven test failures ignored on the command line' },
  { re: MAVEN_SKIP, severity: 'high', message: 'Maven tests skipped on the command line (-DskipTests/-Dmaven.test.skip)', id: 'mvn-skip' },
  { re: /-D(?:it\.)?test=|-Dsurefire\.excludes=|-DexcludedGroups=/, severity: 'high', message: 'Maven test selection narrowed on the command line' },
  { re: /-Dgroups=|-DfailIfNoTests=false|-Dsurefire\.failIfNoSpecifiedTests=false|-Dsurefire\.rerunFailingTestsCount=[1-9]/, severity: 'medium', message: 'Maven test filtering/retry option added' },
  // Gradle (verified: Test DSL, controlling_task_execution, java_testing, test-retry plugin README)
  { re: /\bignoreFailures\s*(?:=|\s)\s*true\b/, severity: 'critical', message: 'Gradle ignoreFailures: the build passes when tests fail', only: GRADLE_FILE },
  { re: /\bcheck\.dependsOn\.remove\s*\(|tasks\.named\(\s*["']test["']\s*\)\s*\{\s*enabled\s*=\s*false|\btest\.enabled\s*=\s*false/, severity: 'critical', message: 'Gradle test task disabled', only: GRADLE_FILE },
  { re: /\benabled\s*=\s*false\b/, severity: 'high', message: 'the Gradle test task is disabled (SKIPPED)', only: GRADLE_FILE, id: 'gradle-enabled' },
  { re: /\bonlyIf\s*[({]/, severity: 'high', message: 'Gradle onlyIf predicate: the task is SKIPPED when it is false', only: GRADLE_FILE },
  { re: /\bexcludeTestsMatching\s*\(|\bsetExcludes\s*\(|\bexclude\s*[("']\s*["']?[^"'\n]*(?:\*\*\/|\*\.class|\*\.java|\*\.kt|Test|Spec|IT)\b/, severity: 'high', message: 'Gradle test exclude added', only: GRADLE_FILE, id: 'ignore' },
  { re: /\bincludeTestsMatching\s*\(|\bsetIncludes\s*\(/, severity: 'medium', message: 'Gradle test include filter narrows what runs', only: GRADLE_FILE },
  { re: /\bexclude(?:Tags|Groups|Engines|Categories)\s*\(/, severity: 'medium', message: 'Gradle test tags/groups excluded', only: GRADLE_FILE },
  { re: /\bfailOnNoMatchingTests\s*=\s*false|\bscanForTestClasses\s*=\s*false/, severity: 'medium', message: 'Gradle test discovery relaxed', only: GRADLE_FILE },
  { re: /\bretry\s*\{|\bmaxRetries\s*(?:=|\.set\()\s*[1-9]/, severity: 'medium', message: 'Gradle test-retry: failed tests passing on retry do not fail the task', only: GRADLE_FILE },
  { re: GRADLE_EXCLUDE, severity: 'high', message: 'Gradle test task excluded on the command line (-x test)', id: 'gradle-x' },
  { re: /\bgradlew?\b[^\n]*(?:\s--tests[=\s]|-Dtest\.single=)/, severity: 'high', message: 'Gradle test selection narrowed on the command line (--tests)' },
  // .NET project files (verified: Microsoft.NET.Test.Sdk.props sets IsTestProject=true; dotnet test runs every test project)
  { re: /<IsTestProject>\s*false\s*</i, severity: 'critical', message: 'IsTestProject=false: the project is no longer run by dotnet test', only: DOTNET_PROJ },
  { re: /<Compile\s+Remove\s*=\s*"[^"]*(?:[Tt]est|[Ss]pec)/, severity: 'critical', message: 'test sources removed from compilation (<Compile Remove>)', only: DOTNET_PROJ },
  { re: /<VSTestTestCaseFilter>/, severity: 'high', message: 'VSTestTestCaseFilter: only matching tests run', only: DOTNET_PROJ },
  { re: /<TestingPlatformCommandLineArguments>[^<]*(?:--filter|--ignore-exit-code|--minimum-expected-tests\s+0)/, severity: 'high', message: 'testing platform arguments filter tests or ignore failures', only: DOTNET_PROJ },
  { re: /<IsTestingPlatformApplication>\s*false/i, severity: 'medium', message: 'IsTestingPlatformApplication=false', only: DOTNET_PROJ },
  { re: /<RunSettingsFilePath>/, severity: 'low', message: 'run settings file changed', only: DOTNET_PROJ },
  // .runsettings (verified: https://learn.microsoft.com/en-us/visualstudio/test/configure-unit-tests-by-using-a-dot-runsettings-file)
  { re: /<TestCaseFilter>/, severity: 'high', message: 'runsettings TestCaseFilter: only matching tests run', only: /\.runsettings$/ },
  { re: /<TreatNoTestsAsError>\s*false|<MapNotRunnableToFailed>\s*false/i, severity: 'medium', message: 'runsettings: zero or not-runnable tests no longer fail the run', only: /\.runsettings$/ },
  { re: /<MapInconclusiveToFailed>\s*false/i, severity: 'low', message: 'runsettings: inconclusive tests no longer fail the run', only: /\.runsettings$/ },
  // xunit.runner.json (verified: https://xunit.net/docs/config-xunit-runner-json; unverified: the v3 `explicit` key)
  { re: /"failSkips"\s*:\s*false/, severity: 'medium', message: 'xunit failSkips=false: skipped tests no longer fail the run', only: /xunit\.runner\.json$/ },
  { re: /"explicit"\s*:\s*"only"/, severity: 'high', message: 'xunit explicit=only: only explicit tests run', only: /xunit\.runner\.json$/ },
  { re: /"failWarns"\s*:\s*false/, severity: 'low', message: 'xunit failWarns=false', only: /xunit\.runner\.json$/ },
  // dotnet test command lines (verified: dotnet-test, selective-unit-tests, microsoft-testing-platform-troubleshooting pages)
  { re: /--ignore-exit-code\s+\S*\b(?:2|8)\b|TESTINGPLATFORM_EXITCODE_IGNORE/, severity: 'critical', message: 'test failure exit codes ignored (--ignore-exit-code)' },
  { re: /\bdotnet\s+test\b[^\n]*(?:\s-t\b|--list-tests\b)/, severity: 'critical', message: 'dotnet test --list-tests lists tests instead of running them' },
  { re: /-p:IsTestProject=false\b/, severity: 'critical', message: 'IsTestProject=false on the command line' },
  { re: /\bdotnet\s+test\b[^\n]*(?:--filter(?:-[\w-]+)?[=\s]|--treenode-filter\b)|-p:VSTestTestCaseFilter=/, severity: 'high', message: 'dotnet test selection narrowed (--filter)' },
  { re: /RunConfiguration\.TreatNoTestsAsError=false|MapInconclusiveToFailed=[Ff]alse|--minimum-expected-tests\s+0\b/, severity: 'medium', message: 'dotnet test failure mapping relaxed' },
  // cargo command lines (verified: cargo-test, rustc tests CLI, nextest filtersets pages)
  { re: /\bcargo\s+test\b[^\n]*--no-run\b/, severity: 'critical', message: 'cargo test --no-run compiles but does not run the tests' },
  { re: /\bcargo\s+test\b[^\n]*\s--\s[^\n]*(?:--skip[=\s]|--exact\b|--ignored\b(?!-))|\bcargo\s+nextest\s+run\b[^\n]*(?:--skip[=\s]|\s-E\s|--filterset\b|--run-ignored\s+only\b)/, severity: 'high', message: 'cargo test selection narrowed on the command line (--skip/--exact/--ignored/-E)' },
  { re: /\bcargo\s+(?:test|nextest\s+run)\b[^\n]*--exclude\b/, severity: 'high', message: 'cargo test --exclude: a package is no longer tested' },
  { re: /\bcargo\s+test\s+(?!-)[A-Za-z_][\w:]*\b/, severity: 'medium', message: 'cargo test <filter>: only tests whose name contains the filter run' },
];
/** Removed dependency/plugin lines that stop a runner from discovering tests at all. */
const TEST_RUNNER_DECL = /\buseJUnitPlatform\s*\(|\buseTestNG\s*\(|\buseJUnit\s*\(|Include\s*=\s*"(?:Microsoft\.NET\.Test\.Sdk|Microsoft\.Testing\.Platform|MSTest\.Sdk|xunit\.v3|xunit\.runner\.visualstudio|NUnit3TestAdapter|MSTest\.TestAdapter)"/;

function quoted(text: string): string[] {
  return [...text.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1] as string);
}

function scanConfigFile(ctx: Ctx, movedPair: boolean): void {
  const { file } = ctx;
  const p = file.path.replace(/\\/g, '/');
  const isWorkflow = /(^|\/)\.github\/workflows\//.test(p);
  const isJson = p.endsWith('.json');
  const isMakefile = /(^|\/)makefile$/i.test(p);
  const isGradle = GRADLE_FILE.test(p);
  const isProj = DOTNET_PROJ.test(p);
  if (file.status === 'deleted') {
    if (isWorkflow && !movedPair) add(ctx, 'ci-workflow-deleted', 'high', null, 'CI workflow deleted', file.path, null);
    return;
  }
  const fileAdded = file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === '+').map((l) => l.text)).join('\n');
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
        // Gradle `useJUnitPlatform()` is what makes Jupiter tests discoverable; Microsoft.NET.Test.Sdk is what makes a project a test project.
        if ((isGradle || isProj) && TEST_RUNNER_DECL.test(line.text) && !TEST_RUNNER_DECL.test(fileAdded)) {
          add(ctx, 'test-step-removed', 'high', line, isGradle ? 'test framework registration removed (useJUnitPlatform/useTestNG): the test task discovers nothing' : 'test SDK/adapter package removed: dotnet test no longer runs this project', line.text, null);
        }
        continue;
      }
      if (line.kind !== '+') continue;
      const text = line.text;
      // Comments are prose, not configuration.
      if (!isJson && /^\s*#/.test(text)) continue;
      if (/^\s*\/\//.test(text) || /^\s*<!--/.test(text)) continue;
      // A YAML step name that mentions a command is prose too.
      if (!isJson && /^\s*-?\s*(?:name|description)\s*:\s/.test(text)) continue;
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
            severity = 'low';
            message = 'continue-on-error added to a CI step that does not run tests';
          }
        }
        if (rule.id === 'ignore') {
          // The list may span several lines: `exclude: [` then one entry per line.
          let entries = quoted(text);
          if (entries.length === 0 && /[\[(]\s*$/.test(text)) {
            for (let j = i + 1; j < Math.min(hunk.lines.length, i + 24); j++) {
              const l = hunk.lines[j] as DiffLine;
              if (l.kind === '-') continue;
              entries = entries.concat(quoted(l.text));
              if (/[\])]/.test(l.text)) break;
            }
          }
          if (entries.length > 0 && entries.every((e) => BENIGN_IGNORE.test(e) || BENIGN_JVM_EXCLUDE.test(e))) continue;
        }
        if (rule.id === 'xml-exclude') {
          // <exclude>**/*IT.java</exclude> hands integration tests to Failsafe; the same pattern inside a failsafe
          // configuration is a real exclusion, which a line-based scan cannot tell apart (documented, suppressible).
          const entries = [...text.matchAll(/<exclude>([^<]*)<\/exclude>/g)].map((m) => m[1] as string);
          if (entries.length > 0 && entries.every((e) => BENIGN_JVM_EXCLUDE.test(e))) continue;
        }
        if (rule.id === 'mvn-skip' || rule.id === 'gradle-x') {
          // `mvn -DskipTests package` followed by `mvn test` (build first, test later) still runs the tests.
          const stillRuns = rule.id === 'mvn-skip' ? new RegExp(`\\bmvnw?\\b(?![^\\n]*(?:${MAVEN_SKIP.source}))[^\\n]*\\b(?:test|verify|integration-test)\\b`).test(fileAdded) : new RegExp(`\\bgradlew?\\b(?![^\\n]*\\s(?:-x|--exclude-task)\\s+(?:test|check)\\b)[^\\n]*\\b(?:test|check|build)\\b`).test(fileAdded);
          if (stillRuns) {
            severity = 'low';
            message = `${message}; another step still runs the tests`;
          }
        }
        if (rule.id === 'gradle-enabled') {
          // Which task? Walk back to the enclosing `tasks.named("x") {` / `x {` block; a jar/javadoc task is not the tests.
          let task: string | null = null;
          for (let j = i - 1; j >= Math.max(0, i - 6) && task === null; j--) {
            const l = hunk.lines[j] as DiffLine;
            if (l.kind === '-') continue;
            const m = /tasks\.named\s*(?:<[^>]*>)?\s*\(\s*["'](\w+)["']|tasks\.(\w+)\s*\{|^\s*(\w+)\s*\{/.exec(l.text);
            if (m) task = m[1] ?? m[2] ?? m[3] ?? null;
          }
          if (task !== null && !/test|check|verif/i.test(task)) {
            severity = 'low';
            message = `Gradle task ${task} disabled (not a test task)`;
          }
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
  // Path rules plus the lazy content sniff (after, then before: a removed inline module is still a test file); one
  // verdict per path, so the reads happen at most once.
  const verdicts = new Map<string, boolean>();
  const isTest = (path: string, deleted: boolean): boolean => {
    let v = verdicts.get(path);
    if (v === undefined) {
      v = isTestFile(path, deleted ? [() => opts.readBefore(path)] : [() => opts.readAfter(path), () => opts.readBefore(path)]);
      verdicts.set(path, v);
    }
    return v;
  };

  // Test declarations added per file (for cross-file move reconciliation).
  const cross: CrossFile = { addedByFile: new Map() };
  for (const file of files) {
    if (file.binary || !isTest(file.path, file.status === 'deleted')) continue;
    const lang = langOf(file.path);
    const titles = new Map<string, number>();
    const after = lang === 'rust' ? opts.readAfter(file.path) : null;
    const lines = after ? regionLines(after, rustTestRegions(normalizeFile(lang, after))) : null;
    const inRegion = (l: DiffLine) => lines === null || (l.newNo !== null && lines.has(l.newNo));
    for (const d of declarationLines(lang, file.hunks.flatMap((h) => h.lines), '+', inRegion)) titles.set(d, (titles.get(d) ?? 0) + 1);
    cross.addedByFile.set(file.path, titles);
  }

  for (const file of files) {
    if (file.binary) continue;
    const lang = langOf(file.path);
    const ctx: Ctx = { file, lang, findings, ci: opts.ci ?? false };
    const movedPair = pairs.has(file.path);
    if (isTest(file.path, file.status === 'deleted') || (file.oldPath && isTest(file.oldPath, true))) {
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
