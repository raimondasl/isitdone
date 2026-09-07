/**
 * Rust, Java/Kotlin and C# in the test-integrity scanner: classification (path rules + content sniff), counting
 * (Rust #[cfg(test)] regions, attribute rows), the attribute-aware declaration key that keeps moves and reason-only
 * skip edits quiet, every detector per language, and one configuration case per build tool.
 */
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, type DiffFile } from '../src/diff.js';
import { checkEditedFile } from '../src/editcheck.js';
import { countTests, isTestConfigFile, isTestFile, langOf, scanIntegrity, type Finding, type ScanOptions } from '../src/integrity.js';
import { tempRepo } from './helpers.js';

interface Case {
  files: DiffFile[];
  readBefore: ScanOptions['readBefore'];
  readAfter: ScanOptions['readAfter'];
}

/** A diff for one modified file (all lines removed then added in one hunk, like a rewrite). */
function modified(path: string, before: string, after: string): Case {
  return multi({ [path]: [before, after] });
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
const scan = (c: Case) => scanIntegrity(c.files, { readBefore: c.readBefore, readAfter: c.readAfter });
const all = (c: Case) => ids(scan(c).findings);
const medPlus = (c: Case) => scan(c).findings.filter((f) => f.severity !== 'low').map((f) => f.id);

// --- fixtures ---------------------------------------------------------------------------------------

const RS = (body: string) => `use lrucache::Lru;\n\n${body}`;
const RS_TWO = RS('#[test]\nfn evicts_oldest() {\n    let mut c = Lru::new(2);\n    c.put("a", 1);\n    assert_eq!(c.get("a"), Some(&1));\n}\n\n#[test]\nfn get_refreshes() {\n    let mut c = Lru::new(2);\n    assert_eq!(c.get("b"), None);\n}');
const RS_SRC = (gate: string, attr = '#[test]') =>
  `pub fn slugify(s: &str) -> String {\n    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-")\n}\n\npub fn must(s: Option<&str>) -> &str {\n    s.unwrap()\n}\n\n${gate}\nmod tests {\n    use super::slugify;\n\n    ${attr}\n    fn unicode() {\n        assert_eq!(slugify("Crème"), "creme");\n    }\n\n    #[test]\n    fn dashes() {\n        assert_eq!(slugify("a -- b"), "a-b");\n    }\n}`;

const JAVA = (body: string, imports = '') => `package com.acme;\n\nimport static org.junit.jupiter.api.Assertions.*;\n${imports}\nimport org.junit.jupiter.api.Test;\n\nclass GreeterTest {\n${body}\n}`;
const JAVA_TWO = JAVA('    @Test\n    void formal() {\n        String got = Greeter.greet("Ada", Style.FORMAL);\n        assertEquals("Good day, Ada.", got);\n    }\n\n    @Test\n    void casual() {\n        assertEquals("Hey Ada!", Greeter.greet("Ada", Style.CASUAL));\n    }');

const CS = (body: string, using = 'using Xunit;') => `${using}\n\nnamespace Greet.Tests;\n\npublic class GreeterTests\n{\n${body}\n}`;
const CS_TWO = CS('    [Fact]\n    public void Formal()\n    {\n        var got = Greeter.Greet("Ada", Style.Formal);\n        Assert.Equal("Good day, Ada.", got);\n    }\n\n    [Fact]\n    public void Casual()\n    {\n        Assert.Equal("Hey Ada!", Greeter.Greet("Ada", Style.Casual));\n    }');

// --- classification ---------------------------------------------------------------------------------

describe('classification: rust, java/kotlin, c#', () => {
  it('langOf maps the new extensions (Kotlin rides on the JUnit rules; gradle scripts do not)', () => {
    expect(langOf('src/a.rs')).toBe('rust');
    expect(langOf('src/test/java/FooTest.java')).toBe('java');
    expect(langOf('src/test/kotlin/FooTest.kt')).toBe('java');
    expect(langOf('tests/FooTests.cs')).toBe('csharp');
    expect(langOf('build.gradle.kts')).toBe('other');
  });

  it('isTestFile path rules (case-sensitive Maven and PascalCase suffixes)', () => {
    for (const p of ['tests/lru.rs', 'tests/common/mod.rs', 'src/cache/tests.rs', 'src/cache/test.rs', 'src/foo_test.rs', 'src/foo_tests.rs', 'src/test/java/com/acme/FooTest.java', 'src/it/java/com/acme/FooIT.java', 'src/integrationTest/java/X.java', 'FooTest.java', 'FooTests.java', 'FooTestCase.java', 'FooIT.java', 'ITFoo.java', 'TestFoo.java', 'src/test/kotlin/FooTest.kt', 'FooSpec.kt', 'tests/Cache.Tests/LruCacheTests.cs', 'Cache.Tests/Any.cs', 'test/Any.cs', 'src/FooTests.cs', 'src/FooTest.cs', 'src/FooSpec.cs', 'src/FooFixture.cs']) expect(isTestFile(p), p).toBe(true);
    for (const p of ['src/lru.rs', 'src/latest.rs', 'benches/x.rs', 'examples/x.rs', 'src/main/java/com/acme/TestRunner.java', 'src/main/java/com/acme/FooTest.java', 'src/Commit.java', 'src/Unit.java', 'src/Latest.cs', 'src/Contests.cs', 'src/Latest.kt', 'src/Requests.cs']) expect(isTestFile(p), p).toBe(false);
  });

  it('content sniff: lazy, in order, bounded, only for the attribute languages', () => {
    expect(isTestFile('src/lru.rs', [() => 'pub fn f() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn a() {}\n}'])).toBe(true);
    expect(isTestFile('src/lru.rs', [() => 'pub fn f() {}\n\n#[cfg(all(test, feature = "slow"))]\nmod tests {}'])).toBe(true);
    expect(isTestFile('src/lru.rs', [() => 'pub fn f() {}\n#[cfg(not(test))]\nfn prod() {}'])).toBe(false);
    expect(isTestFile('src/lru.rs', [() => null, () => '#[tokio::test]\nasync fn a() {}'])).toBe(true); // the second reader (before) is consulted
    expect(isTestFile('src/main/java/com/acme/Foo.java', [() => 'class Foo {\n    @Test\n    void x() {}\n}'])).toBe(true);
    expect(isTestFile('src/Foo.cs', [() => 'public class Foo {\n    [Fact]\n    public void X() {}\n}'])).toBe(true);
    expect(isTestFile('src/Foo.cs', [() => 'var x = list[Test];'])).toBe(false);
    let calls = 0;
    const spy = () => {
      calls++;
      return '#[test]';
    };
    expect(isTestFile('tests/x.rs', [spy])).toBe(true);
    expect(isTestFile('src/a.ts', [spy])).toBe(false);
    expect(isTestFile('src/a.go', [spy])).toBe(false);
    expect(calls).toBe(0); // path rules decide first; other languages never read
    expect(isTestFile('src/big.rs', [() => 'x'.repeat(1024 * 1024 + 1) + '\n#[test]'])).toBe(false); // bounded
  });

  it('isTestConfigFile knows the cargo, maven, gradle, testng and .NET files', () => {
    for (const p of ['Cargo.toml', 'crates/a/Cargo.toml', '.cargo/config.toml', '.cargo/config', '.config/nextest.toml', 'pom.xml', 'sub/pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle.kts', 'gradle.properties', '.mvn/maven.config', 'src/test/resources/testng.xml', 'junit-platform.properties', 'tests/A.Tests/A.Tests.csproj', 'src/B.fsproj', 'Directory.Build.props', 'test.runsettings', 'xunit.runner.json', 'justfile', '.travis.yml', 'bitbucket-pipelines.yml', '.buildkite/pipeline.yml']) expect(isTestConfigFile(p), p).toBe(true);
    for (const p of ['Cargo.lock', 'global.json', 'src/config.rs', 'README.md', 'src/Foo.cs']) expect(isTestConfigFile(p), p).toBe(false);
  });
});

// --- counting ----------------------------------------------------------------------------------------

describe('countTests: rust, java, c#', () => {
  it('rust counts #[test]/#[tokio::test] fns, assert!/unwrap/?/panic!, #[ignore] and cfg_attr ignores', () => {
    const text = '#[test]\nfn a() {\n    let v = parse("x").unwrap();\n    assert_eq!(v, 1);\n}\n\n#[tokio::test(flavor = "multi_thread")]\nasync fn b() -> Result<(), E> {\n    let s = open()?;\n    assert!(s.ok());\n    Ok(())\n}\n\n#[test]\n#[ignore = "slow"]\nfn c() {\n    panic!("no");\n}\n\n#[test]\n#[cfg_attr(miri, ignore)]\nfn d() {\n    debug_assert!(true);\n}';
    expect(countTests('rust', text)).toMatchObject({ tests: 4, assertions: 6, skipped: 2, unknownEach: false });
  });

  it('rust: only the #[cfg(test)] region of a source file counts (production unwraps do not)', () => {
    const c = countTests('rust', RS_SRC('#[cfg(test)]'));
    expect(c).toMatchObject({ tests: 2, assertions: 2, skipped: 0 });
    // no gate at all (an integration test under tests/): the whole file counts
    expect(countTests('rust', 'fn helper() -> u32 { x.unwrap() }\n#[test]\nfn a() { assert!(helper() == 1); }').assertions).toBe(2);
  });

  it('rust: a lifetime in a signature does not blank the assertion that follows it', () => {
    expect(countTests('rust', "#[test]\nfn f<'a>(x: &'a str) { assert_eq!(x, \"a\"); }").assertions).toBe(1);
    expect(countTests('rust', "#[test]\nfn f() { assert_eq!(pad('7', '0'), \"07\"); }").assertions).toBe(1);
  });

  it('rust: rstest/test_case rows are tests and their body assertions run once per row; #[values] is unknown', () => {
    const rstest = '#[rstest]\n#[case(1, 1)]\n#[case(-1, 1)]\n#[case(0, 0)]\nfn abs_cases(#[case] input: i32, #[case] want: i32) {\n    assert_eq!(abs(input), want);\n}';
    expect(countTests('rust', rstest)).toMatchObject({ tests: 4, assertions: 4, unknownEach: false });
    const testCase = '#[test_case(1, 1)]\n#[test_case(-1, 1)]\nfn abs_cases(input: i32, want: i32) {\n    assert_eq!(abs(input), want);\n    assert!(input.abs() >= 0);\n}';
    expect(countTests('rust', testCase)).toMatchObject({ tests: 2, assertions: 4 });
    expect(countTests('rust', '#[rstest]\nfn m(#[values(1, 2)] x: i32) { assert!(x > 0); }').unknownEach).toBe(true);
  });

  it('java counts @Test/@ParameterizedTest, JUnit/AssertJ/Mockito assertions, @Test(expected=), skips and @CsvSource rows', () => {
    const text = JAVA('    @Test\n    void a() {\n        assertEquals(1, f());\n        assertThat(g()).isEqualTo(2);\n        verify(mock).send(any());\n    }\n\n    @Test(expected = IllegalStateException.class)\n    public void b() {\n        f();\n    }\n\n    @Test\n    @Disabled("later")\n    void c() {\n        fail("x");\n    }\n\n    @ParameterizedTest\n    @CsvSource({\n        "1, 1",\n        "-1, 1",\n        "0, 0",\n    })\n    void abs(int input, int want) {\n        assertEquals(want, MathX.abs(input));\n    }');
    expect(countTests('java', text)).toMatchObject({ tests: 6, assertions: 8, skipped: 1, unknownEach: false });
    expect(countTests('java', JAVA('    @ParameterizedTest\n    @MethodSource("cases")\n    void abs(int input, int want) {\n        assertEquals(want, MathX.abs(input));\n    }')).unknownEach).toBe(true);
    // TestNG: a class-level @Test makes every public method a test (count unknown)
    expect(countTests('java', 'import org.testng.annotations.Test;\n\n@Test\npublic class AllTests {\n    public void a() { assertEquals(1, 1); }\n}').unknownEach).toBe(true);
    // @TestInstance / @Testcontainers are not test declarations
    expect(countTests('java', '@TestInstance(Lifecycle.PER_CLASS)\n@Testcontainers\nclass X {\n    @Test\n    void a() {}\n}').tests).toBe(1);
  });

  it('kotlin: kotlin.test/JUnit annotations and assertions count', () => {
    const kt = 'import kotlin.test.Test\nimport kotlin.test.assertEquals\nimport kotlin.test.assertFailsWith\n\nclass CalcTest {\n    @Test\n    fun adds() {\n        assertEquals(4, add(2, 2))\n    }\n\n    @Test\n    fun `rejects negative`() {\n        assertFailsWith<IllegalArgumentException> { add(-1, 1) }\n    }\n}';
    expect(countTests('java', kt)).toMatchObject({ tests: 2, assertions: 2, skipped: 0 });
    expect(medPlus(modified('src/test/kotlin/CalcTest.kt', kt, kt.replace('    @Test\n    fun adds()', '    @Test\n    @Ignore\n    fun adds()')))).toEqual(['skip-added']);
  });

  it('c# counts [Fact]/[Theory]+[InlineData]/[Test]/[TestCase]/[TestMethod], Assert.*/Should()/Verify(, and skips only inside attributes', () => {
    const text = CS('    [Theory]\n    [InlineData(1, 1)]\n    [InlineData(-1, 1)]\n    public void Abs(int input, int want)\n    {\n        Assert.Equal(want, MathX.Abs(input));\n    }\n\n    [Fact(Skip = "flaky")]\n    public void Skipped()\n    {\n        got.Should().Be(1);\n        mock.Verify(m => m.Send(It.IsAny<string>()), Times.Once);\n    }\n\n    [Fact, Trait("Category", "unit")]\n    public void Listed()\n    {\n        var options = new Options { Skip = 10 };\n        Assert.True(options.Skip > 0);\n    }');
    expect(countTests('csharp', text)).toMatchObject({ tests: 5, assertions: 6, skipped: 1, unknownEach: false });
    const nunit = CS('    [Test]\n    public void A() { Assert.That(x, Is.EqualTo(1)); }\n\n    [TestCase(1)]\n    [TestCase(2)]\n    public void B(int n) { ClassicAssert.AreEqual(n, n); }\n\n    [Test]\n    [Ignore("no")]\n    public void C() { Assert.Ignore("later"); }\n\n    [TestCaseSource(nameof(Cases))]\n    public void D(int n) { Assert.Pass(); }', 'using NUnit.Framework;');
    // [TestCaseSource] is a variable table (unknownEach), not a declaration; Assert.Ignore/Pass are not checks
    expect(countTests('csharp', nunit)).toMatchObject({ tests: 4, assertions: 3, skipped: 2, unknownEach: true });
    expect(countTests('csharp', CS('    [TestMethod]\n    [DataRow(1)]\n    [DataRow(2)]\n    public void M(int n) { Assert.AreEqual(n, n); }', 'using Microsoft.VisualStudio.TestTools.UnitTesting;')).tests).toBe(3);
  });
});

// --- rust ----------------------------------------------------------------------------------------------

describe('rust detectors', () => {
  it('#[ignore] tiers: unconditional high, platform cfg_attr low, always-true cfg_attr critical, feature gate high; a reason added is quiet', () => {
    const on = (attr: string) => modified('tests/lru.rs', RS_TWO, RS_TWO.replace('#[test]\nfn evicts_oldest()', `#[test]\n${attr}\nfn evicts_oldest()`));
    expect(all(on('#[ignore]'))).toEqual(['skip-added:high']);
    expect(all(on('#[ignore = "flaky, see #412"]'))).toEqual(['skip-added:high']);
    expect(all(on('#[cfg_attr(miri, ignore)]'))).toEqual(['skip-added:low']);
    expect(all(on('#[cfg_attr(target_os = "windows", ignore)]'))).toEqual(['skip-added:low']);
    expect(all(on('#[cfg_attr(all(), ignore)]'))).toEqual(['skip-added:critical']);
    expect(all(on('#[cfg_attr(feature = "ci", ignore)]'))).toEqual(['skip-added:high']);
    expect(all(on('#[cfg_attr(not(feature = "docker"), ignore)]'))).toEqual(['skip-added:high']);
    const ignored = RS_TWO.replace('#[test]\nfn evicts_oldest()', '#[test]\n#[ignore]\nfn evicts_oldest()');
    expect(scan(modified('tests/lru.rs', ignored, ignored.replace('#[ignore]', '#[ignore = "needs docker"]'))).findings).toEqual([]);
    // the same #[ignore] moved from one test to another is a new skip, not a move
    const other = RS_TWO.replace('#[test]\nfn get_refreshes()', '#[test]\n#[ignore]\nfn get_refreshes()');
    expect(all(modified('tests/lru.rs', ignored, other))).toEqual(['skip-added:high']);
    // #[ignore] in a comment or string is not a skip
    expect(scan(modified('tests/lru.rs', RS_TWO, RS_TWO.replace('fn evicts_oldest()', '// TODO: consider #[ignore] here\nfn evicts_oldest()'))).findings).toEqual([]);
  });

  it('a #[cfg(P)] gate added directly above a test: any() critical, feature high, platform low', () => {
    const on = (attr: string) => modified('tests/lru.rs', RS_TWO, RS_TWO.replace('#[test]\nfn evicts_oldest()', `${attr}\n#[test]\nfn evicts_oldest()`));
    expect(all(on('#[cfg(any())]'))).toEqual(['skip-added:critical']);
    expect(all(on('#[cfg(feature = "slow-tests")]'))).toEqual(['skip-added:high']);
    expect(all(on('#[cfg(unix)]'))).toEqual(['skip-added:low']);
  });

  it('the gate outside the test code: #[cfg(test)] replaced, or `mod tests;` detached, in a source file found by the sniff', () => {
    const src = RS_SRC('#[cfg(test)]');
    const replaced = scan(modified('src/slug.rs', src, RS_SRC('#[cfg(all(test, feature = "slow-tests"))]')));
    expect(ids(replaced.findings)).toEqual(['skip-added:high']);
    expect(replaced.testFiles).toBe(1);
    expect(replaced.findings[0]?.message).toMatch(/gate changed/);
    expect(all(modified('src/slug.rs', src, RS_SRC('#[cfg(any())]')))).toEqual(['skip-added:critical']);
    // the gate dropped entirely still compiles and runs the tests; moved within the file is not a change
    expect(scan(modified('src/slug.rs', src, RS_SRC('#[allow(dead_code)]'))).findings).toEqual([]);
    expect(scan(modified('src/slug.rs', src, src.replace('#[cfg(test)]\nmod tests', '#[cfg(test)]\n#[allow(unused)]\nmod tests'))).findings).toEqual([]);
    const lib = 'pub mod slug;\n\n#[cfg(test)]\nmod tests;\n';
    expect(all(modified('src/lib.rs', lib, 'pub mod slug;\n'))).toEqual(['skip-added:high']);
    expect(scan(modified('src/lib.rs', lib, 'pub mod slug;\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn a() { assert!(true_ish()); }\n}\n')).findings).toEqual([]);
  });

  it('a #[test] attribute swapped out is a removed test; production code outside the region is not scanned', () => {
    const src = RS_SRC('#[cfg(test)]');
    expect(all(modified('src/slug.rs', src, RS_SRC('#[cfg(test)]', '#[allow(dead_code)]')))).toEqual(['tests-removed:medium']);
    // an unwrap replaced in production code is not an assertion downgrade
    expect(scan(modified('src/slug.rs', src, src.replace('s.unwrap()', 's.unwrap_or_default()'))).findings).toEqual([]);
    // and a production file with no tests at all is not a test file
    const r = scan(modified('src/prod.rs', 'pub fn f() -> u32 { g().unwrap() }', 'pub fn f() -> u32 { g().unwrap_or(0) }'));
    expect(r.testFiles).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('#[should_panic]: bare over an asserting body is high, expected= dropped is medium, narrowed is quiet', () => {
    const t = 'use durparse::parse;\n\n#[test]\nfn parses_hours() {\n    assert_eq!(parse("2h").unwrap(), 7200);\n}\n\n#[test]\n#[should_panic(expected = "divide by zero")]\nfn div_zero() {\n    divide(1, 0);\n}';
    expect(all(modified('tests/parse.rs', t, t.replace('#[test]\nfn parses_hours()', '#[test]\n#[should_panic]\nfn parses_hours()')))).toEqual(['assertion-weakened:high']);
    expect(all(modified('tests/parse.rs', t, t.replace('#[should_panic(expected = "divide by zero")]', '#[should_panic]')))).toEqual(['assertion-weakened:medium']);
    expect(scan(modified('tests/parse.rs', t.replace('#[should_panic(expected = "divide by zero")]', '#[should_panic]'), t)).findings).toEqual([]);
    // a genuine "this panics" test (no assertion in the body) is fine
    expect(scan(modified('tests/parse.rs', t, t + '\n\n#[test]\n#[should_panic]\nfn overflow_panics() {\n    add(u32::MAX, 1);\n}')).findings).toEqual([]);
  });

  it('downgrades by subject intersection: assert_eq! -> is_ok(), unwrap -> unwrap_or_default, matches! -> is_err', () => {
    const t = '#[test]\nfn parses() {\n    assert_eq!(parse("2h").unwrap(), Duration::from_secs(7200));\n    let cfg = load(Path::new("a.toml")).unwrap();\n    assert!(matches!(check(&cfg), Err(Error::Missing(_))));\n}';
    expect(all(modified('tests/p.rs', t, t.replace('assert_eq!(parse("2h").unwrap(), Duration::from_secs(7200));', 'assert!(parse("2h").is_ok());')))).toEqual(['assertions-removed:medium', 'assertion-weakened:medium']);
    expect(medPlus(modified('tests/p.rs', t, t.replace('.unwrap();', '.unwrap_or_default();')))).toEqual(['assertions-removed', 'assertion-weakened']);
    expect(medPlus(modified('tests/p.rs', t, t.replace('assert!(matches!(check(&cfg), Err(Error::Missing(_))));', 'assert!(check(&cfg).is_err());')))).toEqual(['assertion-weakened']);
    // a different subject is not a downgrade; assert!(a == b) -> assert_eq!(a, b) is not either
    expect(scan(modified('tests/p.rs', t, t + '\n#[test]\nfn other() {\n    assert!(parse("1m").is_ok());\n}')).findings).toEqual([]);
    expect(scan(modified('tests/q.rs', '#[test]\nfn a() {\n    assert!(got == "x");\n}', '#[test]\nfn a() {\n    assert_eq!(got, "x");\n}')).findings).toEqual([]);
  });

  it('tautologies: assert!(true), assert_eq!(x, x), literal vs literal, and a constant subject', () => {
    const t = '#[test]\nfn counts() {\n    assert_eq!(count_words("a b"), 2);\n}';
    expect(medPlus(modified('tests/w.rs', t, t.replace('assert_eq!(count_words("a b"), 2);', 'assert!(true);')))).toContain('tautology-added');
    expect(medPlus(modified('tests/w.rs', t, t.replace('assert_eq!(count_words("a b"), 2);', 'assert_eq!(got, got);')))).toContain('tautology-added');
    expect(medPlus(modified('tests/w.rs', t, t.replace('assert_eq!(count_words("a b"), 2);', 'assert_eq!("ok", "ok");')))).toContain('tautology-added');
    expect(medPlus(modified('tests/w.rs', t, t.replace('assert_eq!(count_words("a b"), 2);', 'let n = 2;\n    assert_eq!(n, 2);')))).toContain('tautology-added');
    // a counter is not a constant; a constant compared with a computed value is not a tautology
    expect(scan(modified('tests/w.rs', t, t.replace('assert_eq!(count_words("a b"), 2);', 'let mut n = 0;\n    for _ in words("a b") { n += 1; }\n    assert_eq!(n, 2);'))).findings).toEqual([]);
    expect(scan(modified('tests/w.rs', t, t.replace('assert_eq!(count_words("a b"), 2);', 'let want = 2;\n    assert_eq!(count_words("a b"), want);'))).findings).toEqual([]);
  });

  it('early return, swallowed panics, widened tolerances, dropped table rows', () => {
    const t = '#[test]\nfn aligns() {\n    let out = render(&rows);\n    assert_eq!(out.lines().count(), 3);\n}';
    expect(medPlus(modified('tests/r.rs', t, t.replace('    let out', '    if std::env::var("CI").is_ok() {\n        return;\n    }\n    let out')))).toEqual(['early-return-added']);
    expect(all(modified('tests/r.rs', t, t.replace('    let out', '    let _ = std::panic::catch_unwind(|| run());\n    let out')))).toEqual(['error-swallowed:high']);
    expect(all(modified('tests/r.rs', t, t.replace('    let out', '    match run() {\n        Ok(v) => assert_eq!(v, 1),\n        Err(_) => {}\n    }\n    let out')))).toEqual(['error-swallowed:medium']);
    const approx = '#[test]\nfn close() {\n    assert_relative_eq!(area(1.0), 3.14159, epsilon = 1e-6);\n}';
    expect(all(modified('tests/a.rs', approx, approx.replace('1e-6', '1e-2')))).toEqual(['tolerance-widened:high']);
    expect(all(modified('tests/a.rs', approx, approx.replace('1e-6', '5e-6')))).toEqual(['tolerance-widened:low']);
    const table = '#[test]\nfn norm() {\n    let cases = [\n        ("A@B.com", "a@b.com"),\n        ("  a@b.com ", "a@b.com"),\n        ("a+x@b.com", "a@b.com"),\n    ];\n    for (input, want) in cases {\n        assert_eq!(normalize(input), want);\n    }\n}';
    expect(all(modified('tests/n.rs', table, table.replace('        ("a+x@b.com", "a@b.com"),\n', '')))).toEqual(['test-case-removed:medium']);
  });

  it('declaration key: a test moved to another file is a move, not a removal; half a move still reports', () => {
    const pad = '#[test]\nfn pad_left_pads() {\n    assert_eq!(pad_left("7", 3, \'0\'), "007");\n}';
    const before = `use strutil::*;\n\n#[test]\nfn truncates() {\n    assert_eq!(truncate("hello world", 5), "hello…");\n}\n\n${pad}`;
    const after = 'use strutil::*;\n\n#[test]\nfn truncates() {\n    assert_eq!(truncate("hello world", 5), "hello…");\n}';
    const r = scan(multi({ 'tests/strutil.rs': [before, after], 'tests/pad.rs': [null, `use strutil::pad_left;\n\n${pad}`] }));
    expect(ids(r.findings)).toEqual(['tests-moved:low']);
    expect(r.summary).toMatchObject({ testsBefore: 2, testsAfter: 2 });
    // a different test added elsewhere does not absorb the removal (every #[test] line is identical)
    expect(medPlus(multi({ 'tests/strutil.rs': [before, after], 'tests/pad.rs': [null, 'use strutil::pad_left;\n\n#[test]\nfn pad_right_pads() {\n    assert_eq!(pad_right("7", 3), "7  ");\n}'] }))).toEqual(['tests-removed']);
  });

  it('legit refactors: table conversion is low, helper extraction is low, unwrap -> ? is count-neutral', () => {
    const three = '#[test]\nfn p() {\n    assert_eq!(abs(3), 3);\n}\n\n#[test]\nfn n() {\n    assert_eq!(abs(-3), 3);\n}\n\n#[test]\nfn z() {\n    assert_eq!(abs(0), 0);\n}';
    const loop = '#[test]\nfn cases() {\n    for (input, want) in [(3, 3), (-3, 3), (0, 0)] {\n        assert_eq!(abs(input), want, "abs({input})");\n    }\n}';
    expect(scan(modified('tests/abs.rs', three, loop)).blocking).toEqual([]);
    expect(medPlus(modified('tests/abs.rs', three, loop))).toEqual([]);
    const before = '#[test]\nfn a() {\n    let f = File::open("a.bin").unwrap();\n    assert_eq!(read(f).magic, 1);\n}\n\n#[test]\nfn b() {\n    let f = File::open("a.bin").unwrap();\n    assert_eq!(read(f).version, 2);\n}\n\n#[test]\nfn c() {\n    let f = File::open("b.bin").unwrap();\n    assert!(read_err(f).is_err());\n}';
    const helper = 'fn fixture(name: &str) -> File {\n    File::open(name).unwrap()\n}\n\n#[test]\nfn a() {\n    assert_eq!(read(fixture("a.bin")).magic, 1);\n}\n\n#[test]\nfn b() {\n    assert_eq!(read(fixture("a.bin")).version, 2);\n}\n\n#[test]\nfn c() {\n    assert!(read_err(fixture("b.bin")).is_err());\n}';
    expect(all(modified('tests/h.rs', before, helper))).toEqual(['assertions-removed:low']);
    const q = modified('tests/s.rs', '#[test]\nfn put_get() {\n    let s = Store::temp().unwrap();\n    s.put("k", b"v").unwrap();\n    assert_eq!(s.get("k").unwrap(), b"v");\n}', '#[test]\nfn put_get() -> Result<(), Box<dyn std::error::Error>> {\n    let s = Store::temp()?;\n    s.put("k", b"v")?;\n    assert_eq!(s.get("k")?, b"v");\n    Ok(())\n}');
    expect(scan(q).findings).toEqual([]);
  });
});

// --- java / kotlin -------------------------------------------------------------------------------------

describe('java detectors', () => {
  it('skip tiers: @Disabled/@Ignore high, class-level critical, assume on env high, other assume medium, @DisabledOnOs low, @DisabledIf medium', () => {
    const on = (attr: string) => modified('src/test/java/com/acme/GreeterTest.java', JAVA_TWO, JAVA_TWO.replace('    @Test\n    void formal()', `    @Test\n    ${attr}\n    void formal()`));
    expect(all(on('@Disabled("flaky, see #412")'))).toEqual(['skip-added:high']);
    expect(all(on('@Ignore'))).toEqual(['skip-added:high']);
    expect(all(on('@DisabledOnOs(OS.WINDOWS)'))).toEqual(['skip-added:low']);
    expect(all(on('@DisabledIfEnvironmentVariable(named = "CI", matches = "true")'))).toEqual(['skip-added:medium']);
    expect(all(on('@EnabledIfEnvironmentVariable(named = "RUN_SLOW", matches = "true")'))).toEqual(['skip-added:high']);
    const body = (stmt: string) => modified('src/test/java/com/acme/GreeterTest.java', JAVA_TWO, JAVA_TWO.replace('        String got', `        ${stmt}\n        String got`));
    expect(all(body('assumeTrue(System.getenv("RUN_SLOW") != null);'))).toEqual(['skip-added:high']);
    expect(all(body('assumeTrue(Files.exists(fontDir));'))).toEqual(['skip-added:medium']);
    expect(all(body('Assumptions.abort("later");'))).toEqual(['skip-added:high']);
    expect(all(modified('src/test/java/com/acme/GreeterTest.java', JAVA_TWO, JAVA_TWO.replace('class GreeterTest {', '@Disabled("all of it")\nclass GreeterTest {')))).toEqual(['skip-added:critical']);
    expect(all(modified('src/test/java/com/acme/X.java', 'class X {\n    @Test(enabled = true)\n    public void a() { assertEquals(1, f()); }\n}', 'class X {\n    @Test(enabled = false)\n    public void a() { assertEquals(1, f()); }\n}'))).toEqual(['skip-added:high']);
    // a positive gate on a brand-new test is low; a reason added to an existing @Disabled is quiet
    expect(all(modified('src/test/java/com/acme/GreeterTest.java', JAVA_TWO, JAVA_TWO.replace('\n}', '\n\n    @Test\n    @EnabledOnOs(OS.LINUX)\n    void procfs() {\n        assertEquals("ok", Proc.read());\n    }\n}')))).toEqual(['skip-added:low']);
    const disabled = JAVA_TWO.replace('    @Test\n    void formal()', '    @Test\n    @Disabled\n    void formal()');
    expect(scan(modified('src/test/java/com/acme/GreeterTest.java', disabled, disabled.replace('@Disabled', '@Disabled("needs fonts")'))).findings).toEqual([]);
  });

  it('@Test removed, @Test(expected) widened, assertThrows widened, assertEquals -> assertNotNull, Mockito any()', () => {
    const file = 'src/test/java/com/acme/GreeterTest.java';
    expect(all(modified(file, JAVA_TWO, JAVA_TWO.replace('    @Test\n    void casual()', '    void casual()')))).toEqual(['tests-removed:medium']);
    expect(medPlus(modified(file, JAVA_TWO, JAVA_TWO.replace('assertEquals("Good day, Ada.", got);', 'assertNotNull(got);')))).toEqual(['assertion-weakened']);
    const throws = JAVA('    @Test\n    void expired() {\n        assertThrows(ExpiredTokenException.class, () -> verifier.verify(token, later));\n    }\n\n    @Test(expected = BadSignatureException.class)\n    public void tampered() {\n        verifier.verify(token + "x", now);\n    }');
    expect(medPlus(modified(file, throws, throws.replace('assertThrows(ExpiredTokenException.class', 'assertThrows(Exception.class')))).toEqual(['assertion-weakened']);
    expect(medPlus(modified(file, throws, throws.replace('@Test(expected = BadSignatureException.class)', '@Test(expected = Exception.class)')))).toEqual(['assertion-weakened']);
    // narrowing is quiet; JUnit 4 -> 5 migration is count-neutral
    expect(scan(modified(file, throws.replace('assertThrows(ExpiredTokenException.class', 'assertThrows(Exception.class'), throws)).findings).toEqual([]);
    expect(scan(modified(file, throws, throws.replace('    @Test(expected = BadSignatureException.class)\n    public void tampered() {\n        verifier.verify(token + "x", now);', '    @Test\n    void tampered() {\n        assertThrows(BadSignatureException.class, () -> verifier.verify(token + "x", now));'))).findings).toEqual([]);
    const mock = JAVA('    @Test\n    void sendsMail() {\n        Mailer mailer = mock(Mailer.class);\n        new Signup(mailer).run("Ada");\n        verify(mailer).send(eq("ada@example.com"), eq("Welcome"));\n    }');
    expect(medPlus(modified(file, mock, mock.replace('send(eq("ada@example.com"), eq("Welcome"))', 'send(any(), any())')))).toEqual(['assertion-weakened']);
    expect(medPlus(modified(file, mock.replace('verify(mailer)', 'verify(mailer, times(1))'), mock.replace('verify(mailer)', 'verify(mailer, atLeastOnce())')))).toEqual(['assertion-weakened']);
    // AssertJ migration keeps the strength
    expect(scan(modified(file, JAVA_TWO, JAVA_TWO.replace('assertEquals("Good day, Ada.", got);', 'assertThat(got).isEqualTo("Good day, Ada.");'))).findings).toEqual([]);
  });

  it('tautologies (JUnit 4 message-first too), constant subject, expecting the assertion error itself, empty catch of AssertionError', () => {
    const file = 'src/test/java/com/acme/GreeterTest.java';
    const t = JAVA('    @Test\n    void counts() {\n        assertEquals(4, WordCounter.count("a b c d"));\n    }');
    const rep = (s: string) => modified(file, t, t.replace('assertEquals(4, WordCounter.count("a b c d"));', s));
    expect(medPlus(rep('assertTrue(true);'))).toContain('tautology-added');
    expect(medPlus(rep('assertTrue("still works", true);'))).toContain('tautology-added');
    expect(medPlus(rep('assertEquals(got, got);'))).toContain('tautology-added');
    expect(medPlus(rep('assertEquals(4, 4);'))).toContain('tautology-added');
    expect(medPlus(rep('assertThat(got).isEqualTo(got);'))).toContain('tautology-added');
    expect(medPlus(rep('int n = 4;\n        assertEquals(4, n);'))).toContain('tautology-added');
    expect(scan(rep('int n = WordCounter.count("a b c d");\n        assertEquals(4, n);')).findings).toEqual([]);
    expect(all(rep('assertThrows(AssertionError.class, () -> assertEquals(4, WordCounter.count("a b c d")));'))).toEqual(['assertion-weakened:high']);
    expect(all(rep('try {\n            assertEquals(4, WordCounter.count("a b c d"));\n        } catch (AssertionError ignored) {\n        }'))).toEqual(['error-swallowed:high']);
    expect(all(rep('try {\n            assertEquals(4, WordCounter.count("a b c d"));\n        } catch (IOException e) {\n        }'))).toEqual(['error-swallowed:medium']);
    expect(all(rep('if (System.getenv("CI") != null) return;\n        assertEquals(4, WordCounter.count("a b c d"));'))).toEqual(['early-return-added:high']);
  });

  it('@CsvSource rows: a dropped row is a removed case and a removed test; consolidation into a parameterized test is quiet', () => {
    const file = 'src/test/java/com/acme/MailTest.java';
    const csv = JAVA('    @ParameterizedTest\n    @CsvSource({\n        "Bob@Example.COM, bob@example.com",\n        "\'  bob@example.com \', bob@example.com",\n        "bob+news@example.com, bob@example.com",\n    })\n    void normalizes(String input, String want) {\n        assertEquals(want, Normalizer.normalize(input));\n    }');
    expect(all(modified(file, csv, csv.replace('        "bob+news@example.com, bob@example.com",\n', '')))).toEqual(['tests-removed:medium', 'test-case-removed:medium']);
    const three = JAVA('    @Test\n    void positive() {\n        assertEquals(3, MathX.abs(3));\n    }\n\n    @Test\n    void negative() {\n        assertEquals(3, MathX.abs(-3));\n    }\n\n    @Test\n    void zero() {\n        assertEquals(0, MathX.abs(0));\n    }');
    const param = JAVA('    @ParameterizedTest\n    @CsvSource({\n        "3, 3",\n        "-3, 3",\n        "0, 0",\n    })\n    void abs(int input, int want) {\n        assertEquals(want, MathX.abs(input));\n    }');
    expect(scan(modified(file, three, param)).findings).toEqual([]);
    // a variable source keeps the drop at low
    expect(scan(modified(file, three, JAVA('    @ParameterizedTest\n    @MethodSource("cases")\n    void abs(int input, int want) {\n        assertEquals(want, MathX.abs(input));\n    }'))).blocking).toEqual([]);
  });

  it('declaration key: a test moved to another class is a move; the same @Test line elsewhere does not hide a removal', () => {
    const a = 'src/test/java/com/acme/StrUtilTest.java';
    const b = 'src/test/java/com/acme/PadTest.java';
    const pad = '    @Test\n    void padLeftPadsToWidth() {\n        assertEquals("007", StrUtil.padLeft("7", 3, \'0\'));\n    }';
    const before = JAVA(`    @Test\n    void truncateAddsEllipsis() {\n        assertEquals("hello…", StrUtil.truncate("hello world", 5));\n    }\n\n${pad}`);
    const after = JAVA('    @Test\n    void truncateAddsEllipsis() {\n        assertEquals("hello…", StrUtil.truncate("hello world", 5));\n    }');
    expect(all(multi({ [a]: [before, after], [b]: [null, JAVA(pad).replace('GreeterTest', 'PadTest')] }))).toEqual(['tests-moved:low']);
    expect(medPlus(multi({ [a]: [before, after], [b]: [null, JAVA('    @Test\n    void padRight() {\n        assertEquals("7  ", StrUtil.padRight("7", 3));\n    }').replace('GreeterTest', 'PadTest')] }))).toEqual(['tests-removed']);
  });

  it('Maven collects tests by name: a rename away from *Test.java is an effective deletion (high when a pom.xml exists)', () => {
    const files = parseUnifiedDiff('diff --git a/src/test/java/com/acme/FooTest.java b/src/test/java/com/acme/FooSpec.java\nsimilarity index 100%\nrename from src/test/java/com/acme/FooTest.java\nrename to src/test/java/com/acme/FooSpec.java\n');
    const content = JAVA('    @Test\n    void a() {\n        assertEquals(1, f());\n    }');
    expect(ids(scanIntegrity(files, { readBefore: () => content, readAfter: (p) => (p === 'pom.xml' ? null : content) }).findings)).toEqual(['test-file-deleted:medium']);
    expect(ids(scanIntegrity(files, { readBefore: () => content, readAfter: (p) => (p === 'pom.xml' ? '<project/>' : content) }).findings)).toEqual(['test-file-deleted:high']);
    // moving a test class out of src/test is the existing high finding, whatever its content
    const out = parseUnifiedDiff('diff --git a/src/test/java/com/acme/FooTest.java b/src/main/java/com/acme/FooTest.java\nsimilarity index 100%\nrename from src/test/java/com/acme/FooTest.java\nrename to src/main/java/com/acme/FooTest.java\n');
    expect(ids(scanIntegrity(out, { readBefore: () => content, readAfter: () => content }).findings)).toEqual(['test-file-deleted:high']);
  });

  it('helper extraction is low; tolerances: assertEquals delta, AssertJ within, Hamcrest closeTo', () => {
    const file = 'src/test/java/com/acme/CfgTest.java';
    const before = JAVA('    @Test\n    void port() {\n        Config cfg = Loader.load(Path.of("a.toml"));\n        assertNotNull(cfg);\n        assertEquals(8080, cfg.port());\n    }\n\n    @Test\n    void host() {\n        Config cfg = Loader.load(Path.of("a.toml"));\n        assertNotNull(cfg);\n        assertEquals("localhost", cfg.host());\n    }\n\n    @Test\n    void override() {\n        Config cfg = Loader.load(Path.of("b.toml"));\n        assertNotNull(cfg);\n        assertEquals(9090, cfg.port());\n    }');
    const after = JAVA('    private static Config load(String name) {\n        Config cfg = Loader.load(Path.of(name));\n        assertNotNull(cfg, name);\n        return cfg;\n    }\n\n    @Test\n    void port() {\n        assertEquals(8080, load("a.toml").port());\n    }\n\n    @Test\n    void host() {\n        assertEquals("localhost", load("a.toml").host());\n    }\n\n    @Test\n    void override() {\n        assertEquals(9090, load("b.toml").port());\n    }');
    expect(all(modified(file, before, after))).toEqual(['assertions-removed:low']);
    const tol = JAVA('    @Test\n    void area() {\n        assertEquals(3.14159, Circle.area(1.0), 1e-6);\n        assertThat(Circle.area(2.0)).isCloseTo(12.566, within(0.001));\n        assertThat(Circle.area(3.0), closeTo(28.27, 0.01));\n    }');
    expect(all(modified(file, tol, tol.replace('1e-6', '0.5')))).toEqual(['tolerance-widened:high']);
    expect(all(modified(file, tol, tol.replace('within(0.001)', 'within(0.01)')))).toEqual(['tolerance-widened:medium']);
    expect(all(modified(file, tol, tol.replace('closeTo(28.27, 0.01)', 'closeTo(28.27, 0.02)')))).toEqual(['tolerance-widened:low']);
    // a two-argument assertEquals with a numeric second argument is not a tolerance
    expect(scan(modified(file, JAVA('    @Test\n    void a() {\n        assertEquals(f(1, 2), 3);\n    }'), JAVA('    @Test\n    void a() {\n        assertEquals(f(1, 2), 300);\n    }'))).findings).toEqual([]);
  });
});

// --- c# -----------------------------------------------------------------------------------------------

describe('c# detectors', () => {
  const file = 'tests/Greet.Tests/GreeterTests.cs';

  it('skips: Skip= / [Ignore] high, class-level critical, [Explicit] high, Assume.That medium; a changed reason is quiet', () => {
    const attr = (a: string) => modified(file, CS_TWO, CS_TWO.replace('    [Fact]\n    public void Formal()', `    ${a}\n    public void Formal()`));
    expect(all(attr('[Fact(Skip = "flaky, see #412")]'))).toEqual(['skip-added:high']);
    expect(all(attr('[Fact]\n    [Ignore("later")]'))).toEqual(['skip-added:high']);
    expect(all(attr('[Fact]\n    [Explicit]'))).toEqual(['skip-added:high']);
    expect(all(attr('[Fact(Explicit = true)]'))).toEqual(['skip-added:high']);
    expect(all(modified(file, CS_TWO, CS_TWO.replace('public class GreeterTests', '[Ignore("all")]\npublic class GreeterTests')))).toEqual(['skip-added:critical']);
    expect(all(modified(file, CS_TWO, CS_TWO.replace('        var got', '        Assume.That(File.Exists(fonts));\n        var got')))).toEqual(['skip-added:medium']);
    expect(all(modified(file, CS_TWO, CS_TWO.replace('        var got', '        Assert.Inconclusive("later");\n        var got')))).toEqual(['skip-added:high']);
    const skipped = CS_TWO.replace('[Fact]\n    public void Formal()', '[Fact(Skip = "TODO")]\n    public void Formal()');
    expect(scan(modified(file, skipped, skipped.replace('Skip = "TODO"', 'Skip = "needs fonts; blocked by #77"'))).findings).toEqual([]);
    // `Skip =` outside an attribute is not a skip
    expect(scan(modified(file, CS_TWO, CS_TWO.replace('        var got', '        var page = new Query { Skip = 10 };\n        var got'))).findings).toEqual([]);
  });

  it('Assert.Pass ends the test early; Assert.Throws<XunitException> around an assertion; empty catch (Exception)', () => {
    expect(all(modified(file, CS_TWO, CS_TWO.replace('        var got', '        Assert.Pass();\n        var got')))).toEqual(['early-return-added:high']);
    expect(all(modified(file, CS_TWO, CS_TWO.replace('        Assert.Equal("Good day, Ada.", got);', '        Assert.Throws<XunitException>(() => Assert.Equal("Good day, Ada.", got));')))).toEqual(['assertion-weakened:high']);
    expect(all(modified(file, CS_TWO, CS_TWO.replace('        Assert.Equal("Good day, Ada.", got);', '        try\n        {\n            Assert.Equal("Good day, Ada.", got);\n        }\n        catch (Exception)\n        {\n        }')))).toEqual(['error-swallowed:high']);
    // a genuine throws test is not an "own failure"
    expect(scan(modified(file, CS_TWO, CS_TWO + '\n\npublic class ParserTests\n{\n    [Fact]\n    public void Garbage()\n    {\n        Assert.ThrowsAny<Exception>(() => Parser.Parse("soon"));\n    }\n}')).findings).toEqual([]);
  });

  it('downgrades: Equal -> NotNull, Throws<T> -> ThrowsAny<Exception>, Is.EqualTo -> Is.Not.Null, Should().Be -> NotBeNull, Times.Once -> AtLeastOnce', () => {
    expect(medPlus(modified(file, CS_TWO, CS_TWO.replace('Assert.Equal("Good day, Ada.", got);', 'Assert.NotNull(got);')))).toEqual(['assertion-weakened']);
    const throws = CS('    [Fact]\n    public void Expired()\n    {\n        Assert.Throws<ExpiredTokenException>(() => _verifier.Verify(token, later));\n    }');
    expect(medPlus(modified(file, throws, throws.replace('Assert.Throws<ExpiredTokenException>', 'Assert.ThrowsAny<Exception>')))).toEqual(['assertion-weakened']);
    expect(scan(modified(file, throws.replace('Assert.Throws<ExpiredTokenException>', 'Assert.ThrowsAny<Exception>'), throws)).findings).toEqual([]);
    const nunit = CS('    [Test]\n    public void Slug()\n    {\n        Assert.That(Slugify.Run("Crème"), Is.EqualTo("creme"));\n    }', 'using NUnit.Framework;');
    expect(medPlus(modified(file, nunit, nunit.replace('Is.EqualTo("creme")', 'Is.Not.Null')))).toEqual(['assertion-weakened']);
    const fluent = CS('    [Fact]\n    public void Formal()\n    {\n        var got = Greeter.Greet("Ada", Style.Formal);\n        got.Should().Be("Good day, Ada.");\n    }', 'using FluentAssertions;\nusing Xunit;');
    expect(medPlus(modified(file, fluent, fluent.replace('got.Should().Be("Good day, Ada.");', 'got.Should().NotBeNull();')))).toEqual(['assertion-weakened']);
    expect(scan(modified(file, CS_TWO, CS_TWO.replace('Assert.Equal("Good day, Ada.", got);', 'got.Should().Be("Good day, Ada.");'))).findings).toEqual([]);
    const moq = CS('    [Fact]\n    public void Sends()\n    {\n        mailer.Verify(m => m.Send(It.Is<string>(s => s == "ada@example.com")), Times.Once());\n    }');
    expect(medPlus(modified(file, moq, moq.replace('Times.Once()', 'Times.AtLeastOnce()')))).toEqual(['assertion-weakened']);
    expect(medPlus(modified(file, moq, moq.replace('It.Is<string>(s => s == "ada@example.com")', 'It.IsAny<string>()')))).toEqual(['assertion-weakened']);
  });

  it('tautologies, constant subject, tolerance, rows, moves, theory consolidation', () => {
    const t = CS('    [Fact]\n    public void Counts()\n    {\n        Assert.Equal(4, WordCounter.Count("a b c d"));\n    }');
    const rep = (s: string) => modified(file, t, t.replace('Assert.Equal(4, WordCounter.Count("a b c d"));', s));
    expect(medPlus(rep('Assert.True(true);'))).toContain('tautology-added');
    expect(medPlus(rep('Assert.Equal(got, got);'))).toContain('tautology-added');
    expect(medPlus(rep('Assert.Equal(4, 4);'))).toContain('tautology-added');
    expect(medPlus(rep('var n = 4;\n        Assert.Equal(4, n);'))).toContain('tautology-added');
    expect(scan(rep('var n = WordCounter.Count("a b c d");\n        Assert.Equal(4, n);')).findings).toEqual([]);
    const tol = CS('    [Fact]\n    public void Area()\n    {\n        Assert.Equal(3.14159, Circle.Area(1.0), precision: 5);\n        Circle.Area(2.0).Should().BeApproximately(12.566, 0.001);\n    }');
    expect(all(modified(file, tol, tol.replace('precision: 5', 'precision: 1')))).toEqual(['tolerance-widened:medium']);
    expect(all(modified(file, tol, tol.replace('0.001', '0.1')))).toEqual(['tolerance-widened:high']);
    const theory = CS('    [Theory]\n    [InlineData("Bob@Example.COM", "bob@example.com")]\n    [InlineData("  bob@example.com ", "bob@example.com")]\n    [InlineData("bob+news@example.com", "bob@example.com")]\n    public void Normalizes(string input, string want)\n    {\n        Assert.Equal(want, Normalizer.Normalize(input));\n    }');
    expect(all(modified(file, theory, theory.replace('    [InlineData("bob+news@example.com", "bob@example.com")]\n', '')))).toEqual(['tests-removed:medium', 'test-case-removed:medium']);
    const facts = CS('    [Fact]\n    public void Positive()\n    {\n        Assert.Equal(3, MathX.Abs(3));\n    }\n\n    [Fact]\n    public void Negative()\n    {\n        Assert.Equal(3, MathX.Abs(-3));\n    }\n\n    [Fact]\n    public void Zero()\n    {\n        Assert.Equal(0, MathX.Abs(0));\n    }');
    const consolidated = CS('    [Theory]\n    [InlineData(3, 3)]\n    [InlineData(-3, 3)]\n    [InlineData(0, 0)]\n    public void Abs(int input, int want)\n    {\n        Assert.Equal(want, MathX.Abs(input));\n    }');
    expect(scan(modified(file, facts, consolidated)).findings).toEqual([]);
    const pad = '    [Fact]\n    public void PadLeftPadsToWidth()\n    {\n        Assert.Equal("007", Str.PadLeft("7", 3, \'0\'));\n    }';
    const before = CS(`    [Fact]\n    public void Truncates()\n    {\n        Assert.Equal("hello…", Str.Truncate("hello world", 5));\n    }\n\n${pad}`);
    const after = CS('    [Fact]\n    public void Truncates()\n    {\n        Assert.Equal("hello…", Str.Truncate("hello world", 5));\n    }');
    expect(all(multi({ [file]: [before, after], 'tests/Greet.Tests/PadTests.cs': [null, CS(pad).replace('GreeterTests', 'PadTests')] }))).toEqual(['tests-moved:low']);
    // dotnet format: [Fact] and the signature on one line before, split after
    const oneLine = 'using Xunit;\nnamespace R {\npublic class BucketTests {\n    [Fact] public void Refills() {\n        Assert.Equal(2, b.Available);\n    }\n    [Fact] public void Capped() {\n        Assert.True(b.Take(4)); Assert.False(b.Take(1));\n    }\n}\n}';
    expect(scan(modified('tests/R/BucketTests.cs', oneLine, CS('    [Fact]\n    public void Refills()\n    {\n        Assert.Equal(2, b.Available);\n    }\n\n    [Fact]\n    public void Capped()\n    {\n        Assert.True(b.Take(4));\n        Assert.False(b.Take(1));\n    }'))).findings).toEqual([]);
  });
});

// --- configuration: one case per build tool -------------------------------------------------------------

describe('configuration: cargo, maven, gradle, testng, dotnet', () => {
  it('Cargo.toml, .cargo/config.toml and nextest.toml', () => {
    expect(all(modified('Cargo.toml', '[lib]\nname = "x"', '[lib]\nname = "x"\ntest = false'))).toEqual(['config-weakened:high']);
    expect(all(modified('Cargo.toml', '[package]\nname = "x"', '[package]\nname = "x"\nautotests = false'))).toEqual(['config-weakened:high']);
    expect(all(modified('Cargo.toml', '[[bench]]\nname = "b"', '[[bench]]\nname = "b"\nharness = false'))).toEqual(['config-weakened:medium']);
    expect(all(modified('Cargo.toml', '[profile.dev]', '[profile.dev]\ndebug-assertions = false'))).toEqual(['config-weakened:medium']);
    expect(scan(modified('Cargo.toml', '[profile.release]', '[profile.release]\npanic = "abort"\nlto = true')).findings).toEqual([]);
    expect(all(modified('.cargo/config.toml', '[build]', '[build]\n[target.x86_64-unknown-linux-gnu]\nrunner = "true"'))).toEqual(['config-weakened:critical']);
    expect(all(modified('.cargo/config.toml', '[build]', '[build]\n[target.aarch64-linux-android]\nrunner = "adb-run"'))).toEqual(['config-weakened:low']);
    expect(all(modified('.config/nextest.toml', '[profile.default]', '[profile.default]\ndefault-filter = "not test(slow)"'))).toEqual(['config-weakened:high']);
    expect(all(modified('.config/nextest.toml', '[profile.ci]', '[profile.ci]\nretries = 2'))).toEqual(['config-weakened:medium']);
    expect(scan(modified('.config/nextest.toml', '[profile.ci]', '[profile.ci]\nfail-fast = false\ntest-threads = 4')).findings).toEqual([]);
  });

  it('cargo command lines in CI', () => {
    const wf = (before: string, after: string) => modified('.github/workflows/ci.yml', `      - run: ${before}`, `      - run: ${after}`);
    expect(all(wf('cargo test --workspace', 'cargo test --workspace -- --skip slow'))).toEqual(['config-weakened:high']);
    expect(all(wf('cargo test', 'cargo test --no-run'))).toEqual(['config-weakened:critical']);
    expect(all(wf('cargo nextest run', "cargo nextest run -E 'not test(integration)'"))).toEqual(['config-weakened:high']);
    expect(all(wf('cargo test --workspace', 'cargo test --workspace --exclude heavy-crate'))).toEqual(['config-weakened:high']);
    expect(all(wf('cargo test', 'cargo test parser'))).toEqual(['config-weakened:medium']);
    expect(scan(wf('cargo test', 'cargo test --all-features --no-fail-fast -- --include-ignored')).findings).toEqual([]);
    expect(scan(wf('cargo test', 'cargo llvm-cov --workspace')).findings).toEqual([]);
    expect(all(wf('cargo test', 'cargo build'))).toEqual(['test-step-removed:high']);
    // a step name that mentions the command is prose
    expect(scan(modified('.github/workflows/ci.yml', '      - run: cargo test', '      - name: cargo test suite\n        run: cargo test')).findings).toEqual([]);
    expect(all(modified('Makefile', 'test:\n\tcargo test', 'test:\n\tcargo test || true'))).toEqual(['config-weakened:critical']);
  });

  it('pom.xml, .mvn/maven.config and mvn command lines', () => {
    expect(all(modified('pom.xml', '  <properties>\n  </properties>', '  <properties>\n    <skipTests>true</skipTests>\n  </properties>'))).toEqual(['config-weakened:critical']);
    expect(all(modified('pom.xml', '  <configuration>\n  </configuration>', '  <configuration>\n    <testFailureIgnore>true</testFailureIgnore>\n  </configuration>'))).toEqual(['config-weakened:critical']);
    expect(all(modified('pom.xml', '  <excludes>\n  </excludes>', '  <excludes>\n    <exclude>**/AuthTest.java</exclude>\n  </excludes>'))).toEqual(['config-weakened:high']);
    expect(scan(modified('pom.xml', '  <excludes>\n  </excludes>', '  <excludes>\n    <exclude>**/*IT.java</exclude>\n    <exclude>**/Abstract*.java</exclude>\n  </excludes>')).findings).toEqual([]);
    expect(all(modified('pom.xml', '  <configuration>\n  </configuration>', '  <configuration>\n    <rerunFailingTestsCount>3</rerunFailingTestsCount>\n  </configuration>'))).toEqual(['config-weakened:medium']);
    expect(scan(modified('pom.xml', '  <configuration>\n  </configuration>', '  <!-- <skipTests>true</skipTests> is not allowed here -->\n  <configuration>\n    <forkCount>2</forkCount>\n  </configuration>')).findings).toEqual([]);
    expect(all(modified('.mvn/maven.config', '-B', '-B\n-DskipTests'))).toEqual(['config-weakened:high']);
    const wf = (before: string, after: string) => modified('.github/workflows/ci.yml', `      - run: ${before}`, `      - run: ${after}`);
    expect(all(wf('mvn verify', 'mvn -DskipTests verify'))).toEqual(['test-step-removed:high', 'config-weakened:high']);
    expect(all(wf('mvn verify', 'mvn -Dmaven.test.failure.ignore=true verify'))).toEqual(['config-weakened:critical']);
    expect(all(wf('mvn test', 'mvn test -Dtest=SmokeTest'))).toEqual(['config-weakened:high']);
    // build first, test later: the skip on the package step is low because a later step still runs the tests
    expect(all(modified('.github/workflows/ci.yml', '      - run: mvn verify', '      - run: mvn -DskipTests package\n      - run: mvn test'))).toEqual(['config-weakened:low']);
    expect(scan(wf('mvn test', './mvnw -B verify')).findings).toEqual([]);
  });

  it('build.gradle(.kts), gradle.properties, testng.xml and gradle command lines', () => {
    expect(all(modified('build.gradle', 'test {\n}', 'test {\n    ignoreFailures = true\n}'))).toEqual(['config-weakened:critical']);
    expect(all(modified('build.gradle.kts', 'tasks.test {\n}', 'tasks.test {\n    enabled = false\n}'))).toEqual(['config-weakened:high']);
    expect(all(modified('build.gradle.kts', 'tasks.named("javadoc") {\n}', 'tasks.named("javadoc") {\n    enabled = false\n}'))).toEqual(['config-weakened:low']);
    expect(all(modified('build.gradle.kts', 'tasks.test {\n    filter {\n    }\n}', 'tasks.test {\n    filter {\n        excludeTestsMatching("com.acme.slow.*")\n    }\n}'))).toEqual(['config-weakened:high']);
    expect(all(modified('build.gradle', 'test {\n}', 'test {\n    exclude "**/Slow*Test.class"\n}'))).toEqual(['config-weakened:high']);
    expect(scan(modified('build.gradle', 'test {\n}', 'test {\n    exclude "**/Abstract*"\n}')).findings).toEqual([]);
    expect(scan(modified('build.gradle.kts', 'dependencies {\n}', 'dependencies {\n    implementation("org.example:lib:1.0") {\n        exclude(group = "commons-logging")\n    }\n}')).findings).toEqual([]);
    expect(all(modified('build.gradle.kts', 'tasks.test {\n    useJUnitPlatform {\n    }\n}', 'tasks.test {\n    useJUnitPlatform {\n        excludeTags("slow")\n    }\n}'))).toEqual(['config-weakened:medium']);
    expect(all(modified('build.gradle.kts', 'tasks.test {\n    useJUnitPlatform()\n}', 'tasks.test {\n}'))).toEqual(['test-step-removed:high']);
    expect(all(modified('build.gradle', 'test {\n}', 'test {\n    retry {\n        maxRetries = 3\n    }\n}'))).toEqual(['config-weakened:medium', 'config-weakened:medium']); // the block and the count, one line each
    expect(all(modified('src/test/resources/testng.xml', '  <test name="all">', '  <test name="all">\n    <groups>\n      <run>\n        <exclude name="slow"/>\n      </run>\n    </groups>'))).toEqual(['config-weakened:high']);
    const wf = (before: string, after: string) => modified('.github/workflows/ci.yml', `      - run: ${before}`, `      - run: ${after}`);
    expect(all(wf('./gradlew build', './gradlew build -x test'))).toEqual(['test-step-removed:high', 'config-weakened:high']);
    expect(all(wf('./gradlew test', './gradlew test --tests "com.acme.Smoke*"'))).toEqual(['config-weakened:high']);
    expect(scan(wf('./gradlew test', './gradlew check --no-daemon')).findings).toEqual([]);
  });

  it('*.csproj, Directory.Build.props, *.runsettings, xunit.runner.json and dotnet test command lines', () => {
    const proj = 'tests/A.Tests/A.Tests.csproj';
    expect(all(modified(proj, '  <PropertyGroup>\n  </PropertyGroup>', '  <PropertyGroup>\n    <IsTestProject>false</IsTestProject>\n  </PropertyGroup>'))).toEqual(['config-weakened:critical']);
    expect(all(modified(proj, '  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />\n    <PackageReference Include="xunit" Version="2.7.0" />\n  </ItemGroup>', '  <ItemGroup>\n    <PackageReference Include="xunit" Version="2.7.0" />\n  </ItemGroup>'))).toEqual(['test-step-removed:high']);
    expect(scan(modified(proj, '  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />\n  </ItemGroup>', '  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.0" />\n  </ItemGroup>')).findings).toEqual([]);
    expect(all(modified(proj, '  <ItemGroup>\n  </ItemGroup>', '  <ItemGroup>\n    <Compile Remove="Integration\\**\\*Tests.cs" />\n  </ItemGroup>'))).toEqual(['config-weakened:critical']);
    expect(all(modified('Directory.Build.props', '  <PropertyGroup>\n  </PropertyGroup>', '  <PropertyGroup>\n    <VSTestTestCaseFilter>Category!=Slow</VSTestTestCaseFilter>\n  </PropertyGroup>'))).toEqual(['config-weakened:high']);
    expect(all(modified('test.runsettings', '  <RunConfiguration>\n  </RunConfiguration>', '  <RunConfiguration>\n    <TestCaseFilter>TestCategory!=Integration</TestCaseFilter>\n  </RunConfiguration>'))).toEqual(['config-weakened:high']);
    expect(all(modified('test.runsettings', '  <RunConfiguration>\n  </RunConfiguration>', '  <RunConfiguration>\n    <TreatNoTestsAsError>false</TreatNoTestsAsError>\n  </RunConfiguration>'))).toEqual(['config-weakened:medium']);
    expect(all(modified('xunit.runner.json', '{\n  "failSkips": true\n}', '{\n  "failSkips": false\n}'))).toEqual(['config-weakened:medium']);
    expect(scan(modified('xunit.runner.json', '{\n}', '{\n  "parallelizeTestCollections": false,\n  "maxParallelThreads": 2\n}')).findings).toEqual([]);
    const wf = (before: string, after: string) => modified('.github/workflows/ci.yml', `      - run: ${before}`, `      - run: ${after}`);
    expect(all(wf('dotnet test', 'dotnet test --filter "Category!=Integration"'))).toEqual(['config-weakened:high']);
    expect(all(wf('dotnet test', 'dotnet test --list-tests'))).toEqual(['config-weakened:critical']);
    expect(all(wf('dotnet test', 'dotnet test -p:IsTestProject=false'))).toEqual(['config-weakened:critical']);
    expect(all(wf('dotnet test', 'dotnet test --ignore-exit-code 2'))).toEqual(['config-weakened:critical']);
    expect(scan(wf('dotnet test', 'dotnet test --no-build --logger trx --collect "XPlat Code Coverage"')).findings).toEqual([]);
  });
});

// --- the edit hook sees inline Rust test modules ------------------------------------------------------------

describe('edit hook: content sniff', () => {
  it('an edited src/*.rs with an inline #[cfg(test)] module is scanned; a plain source file is not', () => {
    const src = RS_SRC('#[cfg(test)]');
    const repo = tempRepo({ files: { 'src/slug.rs': src, 'src/prod.rs': 'pub fn f() -> u32 { g().unwrap() }\n', 'Cargo.toml': '[package]\nname = "x"\n' } });
    try {
      repo.write('src/slug.rs', src.replace('    #[test]\n    fn unicode()', '    #[test]\n    #[ignore]\n    fn unicode()'));
      const r = checkEditedFile(repo.root, 'src/slug.rs');
      expect(r?.notable.map((f) => `${f.id}:${f.severity}`)).toEqual(['skip-added:high']);
      expect(r?.note).toMatch(/weaker tests than HEAD/);
      repo.write('src/prod.rs', 'pub fn f() -> u32 { g().unwrap_or(0) }\n');
      expect(checkEditedFile(repo.root, 'src/prod.rs')).toMatchObject({ report: null, notable: [] });
    } finally {
      repo.cleanup();
    }
  });
});
