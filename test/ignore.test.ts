import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { detectChecks } from '../src/detect.js';
import { ignoreMatcher, ignorePatternError } from '../src/ignore.js';
import { plain } from '../src/output.js';
import { PASSES_FILE, readPasses } from '../src/passes.js';
import { formatReport } from '../src/report.js';
import { verify } from '../src/verify.js';
import { PASS, nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
let markDir: string | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
  if (markDir) rmSync(markDir, { recursive: true, force: true });
  markDir = null;
});

describe('ignore patterns', () => {
  const m = (patterns: string[], prefix = '') => ignoreMatcher(patterns, prefix);

  it('a pattern without a slash matches a name at any depth; with a slash it is anchored at the project root', () => {
    const md = m(['*.md']);
    expect(md('README.md')).toBe(true);
    expect(md('docs/deep/a.md')).toBe(true);
    expect(md('src/a.mdx')).toBe(false);
    expect(md('md')).toBe(false);
    const results = m(['results/**']);
    expect(results('results/a.csv')).toBe(true);
    expect(results('results/x/y/z.json')).toBe(true);
    expect(results('results')).toBe(false);
    expect(results('analysis/results/a.csv')).toBe(false);
    const name = m(['results']);
    expect(name('results/a.csv')).toBe(true);
    expect(name('analysis/results/a.csv')).toBe(true);
    expect(name('results.py')).toBe(false);
    const rooted = m(['/PLAN.md']);
    expect(rooted('PLAN.md')).toBe(true);
    expect(rooted('docs/PLAN.md')).toBe(false);
  });

  it('a trailing slash matches directories only; ** spans directories; * and ? stay in one segment; classes work', () => {
    const dir = m(['drafts/']);
    expect(dir('drafts/a.txt')).toBe(true);
    expect(dir('drafts')).toBe(false);
    // Unlike .gitignore, a trailing slash anchors too (matching less is the safe side); **/ reaches every depth.
    expect(dir('x/drafts/a.txt')).toBe(false);
    expect(m(['**/drafts/'])('x/drafts/a.txt')).toBe(true);
    expect(m(['**/drafts/'])('drafts/a.txt')).toBe(true);
    const mid = m(['a/**/b.txt']);
    expect(mid('a/b.txt')).toBe(true);
    expect(mid('a/x/y/b.txt')).toBe(true);
    expect(mid('c/a/b.txt')).toBe(false);
    const star = m(['docs/*.md']);
    expect(star('docs/a.md')).toBe(true);
    expect(star('docs/sub/a.md')).toBe(false);
    expect(m(['log?.txt'])('logs.txt')).toBe(true);
    expect(m(['log?.txt'])('log/.txt')).toBe(false);
    expect(m(['[ab].txt'])('a.txt')).toBe(true);
    expect(m(['[!ab].txt'])('a.txt')).toBe(false);
    expect(m(['[!ab].txt'])('c.txt')).toBe(true);
    expect(m(['a+b(1).txt'])('a+b(1).txt')).toBe(true);
    expect(m(['./notes.txt'])('notes.txt')).toBe(true);
    expect(m(['./notes.txt'])('sub/notes.txt')).toBe(false);
    expect(m(['./README.md'])('packages/a/README.md')).toBe(false);
  });

  it('never ignores the files that define how checks run, whatever the patterns say', () => {
    const json = m(['*.json', '*.toml', '*.lock', '*.yml', '*.js', '*.txt', '.github/**', 'sub/']);
    for (const kept of ['package.json', 'sub/package.json', 'tsconfig.json', 'tsconfig.build.json', '.eslintrc.json', '.isitdone.json', 'pyproject.toml', 'uv.lock', 'Cargo.lock', '.github/workflows/ci.yml', 'vitest.config.js', 'requirements-dev.txt', 'sub/.gitignore']) {
      expect(json(kept), kept).toBe(false);
    }
    for (const dropped of ['data/x.json', 'results/a.toml', 'notes.txt', '.github/CODEOWNERS', 'sub/readme.txt']) expect(json(dropped), dropped).toBe(true);
    const wide = m(['*.yml', '*.js', '*.ts', '*.json', '.*', '*.txt', 'requirements/', 'config/']);
    for (const kept of ['.golangci.yml', 'karma.conf.js', 'wdio.conf.ts', 'vitest.workspace.ts', 'vitest.e2e.config.ts', 'vitest.config.e2e.ts', 'jest.unit.config.js', 'test/jest-e2e.json', '.eslintignore', '.prettierignore', '.editorconfig', 'turbo.json', 'nx.json', 'Taskfile.yml', 'CMakeLists.txt', 'requirements/dev.txt', '.cargo/config.toml', 'config/jest.config.js']) {
      expect(wide(kept), kept).toBe(false);
    }
  });

  it('matches case-sensitively, so a case slip only makes the check run more often', () => {
    expect(m(['Docs/**'])('docs/a.md')).toBe(false);
  });

  it('a character class never matches a slash, and no pattern makes matching slow', () => {
    expect(m(['a[/]b'])('a/b')).toBe(false);
    expect(m(['x[+-0]y'])('x/y')).toBe(false);
    const started = Date.now();
    const slow = m(['*a*a*a*a*a*a*a*a*b', '**/**/**/**/**/**/**/**/*a*a*a*c']);
    const deep = Array.from({ length: 40 }, () => 'a'.repeat(30)).join('/');
    for (let i = 0; i < 20; i++) expect(slow(`${deep}/${'a'.repeat(200)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('applies relative to the project root inside the repository, and never outside it', () => {
    const sub = m(['*.md', 'docs/**'], 'pkg/');
    expect(sub('pkg/README.md')).toBe(true);
    expect(sub('pkg/docs/a.txt')).toBe(true);
    expect(sub('README.md')).toBe(false);
    expect(sub('docs/a.txt')).toBe(false);
    expect(sub('other/pkg/docs/a.txt')).toBe(false);
  });

  it('a directory entry (submodule, embedded repository) is matched with a trailing slash', () => {
    expect(m(['vendor/**'])('vendor/')).toBe(true);
    expect(m(['vendor'])('vendor/')).toBe(true);
    expect(m(['*.md'])('vendor/')).toBe(false);
  });

  it('rejects patterns it cannot honour or that would match everything', () => {
    for (const bad of ['', ' docs/**', 'docs/** ', '!docs/keep.md', 'docs\\a.md', '../x', 'a/../../b', '*', '**', '/**', '**/*', '*/', '?', '[z-a].txt']) {
      expect(ignorePatternError(bad), JSON.stringify(bad)).not.toBeNull();
    }
    for (const good of ['*.md', 'results/**', 'docs/', '/PLAN.md', '__pycache__', 'a/**/b']) expect(ignorePatternError(good), good).toBeNull();
    expect(ignorePatternError(42)).not.toBeNull();
  });
});

describe('ignore in .isitdone.json', () => {
  it('an unusable list never turns the gate off: it is dropped with a note and the check runs every time', () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ test: PASS }) } });
    const load = (checks: unknown) => {
      writeFileSync(join(repo!.root, '.isitdone.json'), JSON.stringify({ checks }));
      return loadConfig(repo!.root).config;
    };
    for (const [ignore, why] of [[['**'], /match every file/], ['docs/**', /array of path patterns/], [['!docs/x'], /negation/], [['[z-a].txt'], /not a valid pattern/]] as const) {
      const d = detectChecks(repo.root, load({ test: { ignore } }));
      const test = d.checks.find((c) => c.id === 'test');
      expect(test?.cmd).toBe('npm test');
      expect(test?.ignore).toBeUndefined();
      expect(d.notes.join('\n')).toMatch(why);
      expect(d.notes.join('\n')).toMatch(/"test" runs every time until it is fixed/);
    }
  });

  it('a misspelt key in an entry without cmd is a config error; extra keys next to cmd stay tolerated', () => {
    repo = tempRepo({ git: false });
    const load = (checks: unknown) => {
      writeFileSync(join(repo!.root, '.isitdone.json'), JSON.stringify({ checks }));
      return () => loadConfig(repo!.root);
    };
    expect(load({ e2e: { command: 'exit 1', kind: 'full' } })).toThrow(/checks\.e2e has unknown key "command"/);
    expect(load({ test: { cmd: 7 } })).toThrow(/must be a string, false, or an object/);
    expect(load({ e2e: { cmd: 'x', note: 'kept for humans' } })).not.toThrow();
    expect(load({ test: { ignore: ['docs/**'] } })()).toEqual({ config: { checks: { test: { ignore: ['docs/**'] } } }, source: '.isitdone.json' });
  });

  it('without a cmd adjusts the detected check instead of replacing it; with nothing detected it is noted, not run', () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ test: PASS, lint: PASS }) } });
    const d = detectChecks(repo.root, { checks: { test: { ignore: ['docs/**'] }, e2e: { ignore: ['x/**'] } } });
    const test = d.checks.find((c) => c.id === 'test');
    expect(test?.cmd).toBe('npm test');
    expect(test?.kind).toBe('full');
    expect(test?.source).toBe('package.json');
    expect(test?.ignore).toEqual(['docs/**']);
    expect(d.checks.some((c) => c.id === 'e2e')).toBe(false);
    expect(d.notes.join('\n')).toMatch(/check "e2e" in config has no "cmd"/);
    const replaced = detectChecks(repo.root, { checks: { test: { cmd: 'node -e 1', ignore: ['docs/**'] } } }).checks.find((c) => c.id === 'test');
    expect(replaced).toMatchObject({ cmd: 'node -e 1', source: 'config', ignore: ['docs/**'] });
  });
});

/**
 * Checks as plain node commands (no npm: these tests run many verifications and must stay fast on a busy machine).
 * The test check records each run in a file outside the repository, and fails while fail.txt exists.
 */
function markingConfig(mark: string, ignore: string[]): string {
  const p = mark.replace(/\\/g, '/');
  const test = `node -e "require('fs').appendFileSync('${p}','x'); process.exit(require('fs').existsSync('fail.txt') ? 1 : 0)"`;
  return JSON.stringify({ checks: { test: { cmd: test, kind: 'full', ignore }, lint: { cmd: PASS, kind: 'lite' } } });
}

function setup(ignore: string[], extraFiles: Record<string, string> = {}, sub = '') {
  markDir = mkdtempSync(join(tmpdir(), 'isitdone-mark-'));
  const mark = join(markDir, 'runs');
  const files: Record<string, string> = {
    [`${sub}.isitdone.json`]: markingConfig(mark, ignore),
    [`${sub}src.js`]: 'module.exports = 1;\n',
    [`${sub}README.md`]: '# fixture\n',
    [`${sub}docs/guide.md`]: 'guide\n',
    ...extraFiles,
  };
  repo = tempRepo({ files });
  const root = join(repo.root, sub);
  const runs = () => (existsSync(mark) ? readFileSync(mark, 'utf8').length : 0);
  const run = (extra: Partial<Parameters<typeof verify>[0]> = {}) => verify({ root, config: loadConfig(root).config, profile: 'full', ...extra });
  const reconfigure = (patterns: string[]) => writeFileSync(join(root, '.isitdone.json'), markingConfig(mark, patterns));
  return { root, runs, run, reconfigure };
}

describe('reusing a pass while only ignored files change', () => {
  it('reuses the pass while only an ignored file is edited, and says so in the result, receipt and report', async () => {
    const { root, runs, run } = setup(['*.md', 'docs/']);
    const first = await run();
    expect(first.ok).toBe(true);
    expect(runs()).toBe(1);
    expect(readPasses(root).test?.inputs).toMatch(/^[0-9a-f]{64}$/);

    repo!.write('README.md', '# edited\n');
    const second = await run();
    expect(second.cached).toBe(false);
    expect(second.before.state).toBe('STALE');
    expect(second.ok).toBe(true);
    expect(runs()).toBe(1);
    const test = second.ran.find((r) => r.id === 'test');
    expect(test?.reused?.at).toBe(readPasses(root).test?.at);
    expect(test?.durationMs).toBe(0);
    expect(second.ran.find((r) => r.id === 'lint')?.reused).toBeUndefined();
    expect(second.receipt?.status).toBe('PASS');
    expect(second.receipt?.profile).toBe('full');
    expect(second.receipt?.checks.find((c) => c.id === 'test')?.reused).toBeDefined();
    expect(formatReport(second, plain)).toMatch(/reused the pass from .* none of its inputs changed since/);
  });

  it('reuses the pass when ignored files are added or deleted', async () => {
    const { root, runs, run } = setup(['*.md', 'docs/']);
    await run();
    repo!.write('docs/new/notes.md', 'new\n');
    rmSync(join(root, 'docs', 'guide.md'));
    expect((await run()).ran.find((r) => r.id === 'test')?.reused).toBeDefined();
    expect(runs()).toBe(1);
  });

  it('runs again when a file outside the list is edited or added', async () => {
    const { runs, run } = setup(['*.md', 'docs/']);
    await run();
    repo!.write('src.js', 'module.exports = 2;\n');
    const changed = await run();
    expect(changed.ran.find((r) => r.id === 'test')?.reused).toBeUndefined();
    expect(runs()).toBe(2);
    repo!.write('notes.txt', 'not ignored\n');
    await run();
    expect(runs()).toBe(3);
  });

  it('never reuses a pass for --no-cache', async () => {
    const { runs, run } = setup(['*.md']);
    await run();
    repo!.write('README.md', 'x\n');
    await run({ useCache: false });
    expect(runs()).toBe(2);
  });

  it('never reuses a pass for doctor runs, and doctor runs record nothing', async () => {
    const { root, runs, run } = setup(['*.md']);
    await run();
    repo!.write('README.md', 'y\n');
    await run({ dryRun: true });
    expect(runs()).toBe(2);
    repo!.write('src.js', 'changed\n');
    const passesBefore = readFileSync(join(root, '.isitdone', PASSES_FILE), 'utf8');
    await run({ dryRun: true });
    expect(readFileSync(join(root, '.isitdone', PASSES_FILE), 'utf8')).toBe(passesBefore);
  });

  it('forgets the pass when the check fails, so restoring the old files runs it again', async () => {
    const { root, runs, run } = setup(['*.md']);
    await run();
    repo!.write('fail.txt', 'x');
    const failed = await run();
    expect(failed.ok).toBe(false);
    expect(runs()).toBe(2);
    expect(readPasses(root).test).toBeUndefined();
    rmSync(join(root, 'fail.txt'));
    repo!.write('README.md', 'only an ignored file differs from the first run\n');
    const again = await run();
    expect(again.ok).toBe(true);
    expect(again.ran.find((r) => r.id === 'test')?.reused).toBeUndefined();
    expect(runs()).toBe(3);
  });

  it('runs again after the check configuration changes, then reuses the new pass', async () => {
    const { runs, run, reconfigure } = setup(['*.md']);
    await run();
    reconfigure(['*.md', 'docs/']);
    repo!.write('README.md', 'a\n');
    await run();
    expect(runs()).toBe(2);
    repo!.write('README.md', 'b\n');
    await run();
    expect(runs()).toBe(2);
  });

  it('ignores a passes file that was edited by hand', async () => {
    const { root, runs, run } = setup(['*.md']);
    await run();
    const file = join(root, '.isitdone', PASSES_FILE);
    const f = JSON.parse(readFileSync(file, 'utf8'));
    // A harmless-looking edit: without the signature check this record would still be reused below.
    f.checks.test.durationMs += 1;
    writeFileSync(file, JSON.stringify(f));
    expect(readPasses(root)).toEqual({});
    repo!.write('README.md', 'c\n');
    await run();
    expect(runs()).toBe(2);
  });

  it('in a project below the repository top, patterns are relative to the project and files outside it stay inputs', async () => {
    const { runs, run } = setup(['*.md', 'docs/'], { 'other/notes.md': 'outside\n' }, 'pkg/');
    await run();
    expect(runs()).toBe(1);
    repo!.write('pkg/docs/more.md', 'inside, ignored\n');
    await run();
    expect(runs()).toBe(1);
    repo!.write('other/lib.js', 'outside the project root: an input\n');
    await run();
    expect(runs()).toBe(2);
  });

  it('a lite check with an ignore list is reused on lite stops too', async () => {
    markDir = mkdtempSync(join(tmpdir(), 'isitdone-mark-'));
    const mark = join(markDir, 'runs').replace(/\\/g, '/');
    repo = tempRepo({
      files: {
        '.isitdone.json': JSON.stringify({ checks: { test: { cmd: PASS, kind: 'full' }, lint: { cmd: `node -e "require('fs').appendFileSync('${mark}','x')"`, kind: 'lite', ignore: ['*.md'] } } }),
        'README.md': 'a\n',
      },
    });
    const root = repo.root;
    const runs = () => (existsSync(mark) ? readFileSync(mark, 'utf8').length : 0);
    await verify({ root, config: loadConfig(root).config, profile: 'lite' });
    repo.write('README.md', 'b\n');
    const lite = await verify({ root, config: loadConfig(root).config, profile: 'lite' });
    expect(lite.ran.map((r) => `${r.id}:${r.reused ? 'reused' : 'ran'}`)).toEqual(['lint:reused']);
    expect(runs()).toBe(1);
  });

  it('records no pass when the inputs changed while the check ran, so the next run runs it', async () => {
    const { root, runs, run } = setup(['*.md']);
    const first = await run({ onCheckStart: (c) => { if (c.id === 'test') repo!.write('src/new.js', 'added while the check ran\n'); } });
    expect(first.ok).toBe(true);
    expect(readPasses(root).test).toBeUndefined();
    repo!.write('README.md', 'edited\n');
    await run();
    expect(runs()).toBe(2);
  });

  it('never credits a check with files that a later check wrote during the same run', async () => {
    // lint (lite, scoped) fails once out/gen.js exists; test (full) writes it. Before this was handled, lint was
    // recorded for the inputs after the run, including out/gen.js, and reused although it fails on them.
    repo = tempRepo({
      files: {
        '.isitdone.json': JSON.stringify({
          checks: {
            lint: { cmd: `node -e "process.exit(require('fs').existsSync('out/gen.js') ? 1 : 0)"`, kind: 'lite', ignore: ['*.md'] },
            test: { cmd: `node -e "require('fs').mkdirSync('out',{recursive:true}); require('fs').writeFileSync('out/gen.js','1')"`, kind: 'full' },
          },
        }),
        'README.md': 'a\n',
      },
    });
    const root = repo.root;
    const first = await verify({ root, config: loadConfig(root).config, profile: 'full' });
    expect(first.ok).toBe(true);
    expect(readPasses(root).lint).toBeUndefined();
    repo.write('README.md', 'b\n');
    const second = await verify({ root, config: loadConfig(root).config, profile: 'full' });
    expect(second.ran.find((r) => r.id === 'lint')).toMatchObject({ status: 'FAIL' });
    expect(second.ran.find((r) => r.id === 'lint')?.reused).toBeUndefined();
    expect(second.ok).toBe(false);
  });

  it('a receipt never covers files that a reused check did not see', async () => {
    const { runs, run } = setup(['*.md']);
    await run();
    repo!.write('README.md', 'edited\n');
    const second = await run({ onCheckStart: (c) => { if (c.id === 'lint') repo!.write('src/extra.js', 'added during the run\n'); } });
    expect(second.ran.find((r) => r.id === 'test')?.reused).toBeDefined();
    expect(second.receipt?.tree).toBe(second.receipt?.treeBefore);
    const third = await run();
    expect(third.cached).toBe(false);
    expect(third.ran.find((r) => r.id === 'test')?.reused).toBeUndefined();
    expect(runs()).toBe(2);
  });

  it('a check that rewrites its own ignored output is still recorded, and its pass reused', async () => {
    markDir = mkdtempSync(join(tmpdir(), 'isitdone-mark-'));
    const mark = join(markDir, 'runs').replace(/\\/g, '/');
    const test = `node -e "const fs=require('fs'); fs.appendFileSync('${mark}','x'); fs.mkdirSync('results',{recursive:true}); fs.writeFileSync('results/out.txt', String(Date.now()))"`;
    repo = tempRepo({
      files: {
        '.isitdone.json': JSON.stringify({ checks: { test: { cmd: test, kind: 'full', ignore: ['results/**', '*.md'] }, lint: { cmd: PASS, kind: 'lite' } } }),
        'src.js': '1\n',
        'README.md': 'a\n',
        'results/out.txt': 'committed\n',
      },
    });
    const root = repo.root;
    const runs = () => (existsSync(mark) ? readFileSync(mark, 'utf8').length : 0);
    const run = () => verify({ root, config: loadConfig(root).config, profile: 'full' });
    await run(); // rewrites the committed results/out.txt: an existing path modified during the run
    expect(readPasses(root).test).toBeDefined();
    repo.write('README.md', 'b\n');
    expect((await run()).ran.find((r) => r.id === 'test')?.reused).toBeDefined();
    expect(runs()).toBe(1);
  });

  it('a pattern that cannot be used makes the check run every time, and never breaks the run', async () => {
    const { runs, run } = setup(['[z-a].txt']);
    expect((await run()).ok).toBe(true);
    repo!.write('README.md', 'edited\n');
    const second = await run();
    expect(second.ok).toBe(true);
    expect(second.detection.notes.join('\n')).toMatch(/not a valid pattern/);
    expect(runs()).toBe(2);
  });
});
