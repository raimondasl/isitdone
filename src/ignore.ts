/**
 * Per-check "ignore" patterns: files a check does not read, so a change confined to them cannot change its result.
 * Matched against paths relative to the project root. Close to .gitignore, but every doubt resolves toward running
 * the check (a pattern that matches less only costs a run):
 *   - a pattern without any slash ("*.md", "__pycache__") matches a file or directory name at any depth;
 *   - a pattern with a slash anywhere ("results/**", "docs/", "/PLAN.md", "./notes.txt") is anchored at the project
 *     root; "**\/docs/" reaches docs directories at any depth;
 *   - a trailing slash (or "/**") matches directories only; a matched directory covers everything below it;
 *   - "*" and "?" stay within one name, "**" as a whole segment spans directories, "[abc]" / "[!abc]" are classes.
 * Negation ("!") is not supported. Matching is case-sensitive. The matcher works segment by segment without regular
 * expressions, so no pattern can make it slow. Files that define how the checks run (manifests, lockfiles, common
 * test-runner, build and linter configuration, .gitignore) are never ignored, whatever the patterns say.
 */

type Token = { t: 'star' } | { t: 'one' } | { t: 'lit'; c: string } | { t: 'class'; neg: boolean; test: (c: string) => boolean };
/** A pattern segment: the globstar, or a name pattern. */
type Segment = '**' | Token[];
interface Compiled {
  segments: Segment[];
  /** Matches only a directory: something must lie below the matched part (or the path is a directory entry). */
  dirOnly: boolean;
}

/** Why a pattern cannot be used, or null when it can. */
export function ignorePatternError(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return 'must be a non-empty string';
  if (p.trim() !== p) return 'must not start or end with spaces';
  if (p.startsWith('!')) return 'negation ("!") is not supported; list only paths the check never reads';
  if (p.includes('\\')) return 'use forward slashes';
  if (/(^|\/)\.\.(\/|$)/.test(p)) return 'must stay inside the project (no "..")';
  const core = p.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (/^[*?/]*$/.test(core)) return 'would match every file, so the check would never run again';
  try {
    compile(p);
  } catch (err) {
    return `is not a valid pattern (${(err as Error).message})`;
  }
  return null;
}

function parseName(seg: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === '*') {
      while (seg[i + 1] === '*') i++; // "a**b" is just "*"
      tokens.push({ t: 'star' });
    } else if (c === '?') {
      tokens.push({ t: 'one' });
    } else if (c === '[') {
      const close = seg.indexOf(']', i + 2); // "[]...]": a leading "]" is part of the class
      if (close < 0) {
        tokens.push({ t: 'lit', c });
        continue;
      }
      let body = seg.slice(i + 1, close);
      const neg = body.startsWith('!') || body.startsWith('^');
      if (neg) body = body.slice(1);
      const ranges: Array<[string, string]> = [];
      for (let k = 0; k < body.length; k++) {
        const a = body[k] as string;
        if (body[k + 1] === '-' && k + 2 < body.length) {
          const b = body[k + 2] as string;
          if (b < a) throw new Error(`range "${a}-${b}" is out of order`);
          ranges.push([a, b]);
          k += 2;
        } else {
          ranges.push([a, a]);
        }
      }
      if (ranges.length === 0) throw new Error('empty character class');
      tokens.push({ t: 'class', neg, test: (ch) => ranges.some(([lo, hi]) => ch >= lo && ch <= hi) });
      i = close;
    } else {
      tokens.push({ t: 'lit', c });
    }
  }
  return tokens;
}

function compile(pattern: string): Compiled {
  // Any slash anchors, including a leading "./" or "/" and a trailing one: matching less is the safe side.
  const anchored = pattern.includes('/');
  let s = pattern.startsWith('./') ? pattern.slice(2) : pattern;
  s = s.replace(/^\/+/, '');
  let dirOnly = s.endsWith('/');
  s = s.replace(/\/+$/, '');
  const parts = s.split('/').filter((x) => x !== '');
  // A trailing "**" means "everything below": the same as a directory-only pattern for what precedes it.
  while (parts.length > 1 && parts[parts.length - 1] === '**') {
    parts.pop();
    dirOnly = true;
  }
  const segments: Segment[] = [];
  if (!anchored) segments.push('**');
  for (const part of parts) {
    if (part === '**') {
      if (segments[segments.length - 1] !== '**') segments.push('**');
    } else {
      segments.push(parseName(part));
    }
  }
  return { segments, dirOnly };
}

/** Wildcard match of one name, with the classic last-star backtracking: at most O(name x pattern), never exponential. */
function matchName(tokens: Token[], name: string): boolean {
  let ti = 0;
  let ni = 0;
  let starTi = -1;
  let starNi = 0;
  while (ni < name.length) {
    const tok = tokens[ti];
    const c = name[ni] as string;
    if (tok && tok.t !== 'star' && (tok.t === 'one' || (tok.t === 'lit' && tok.c === c) || (tok.t === 'class' && tok.test(c) !== tok.neg))) {
      ti++;
      ni++;
    } else if (tok && tok.t === 'star') {
      starTi = ti++;
      starNi = ni;
    } else if (starTi >= 0) {
      ti = starTi + 1;
      ni = ++starNi;
    } else {
      return false;
    }
  }
  while (tokens[ti]?.t === 'star') ti++;
  return ti === tokens.length;
}

/**
 * Does the pattern match the path (as a file) or one of its directories? `isDir`: the path itself is a directory entry.
 * Dynamic programming over (pattern segment, path segment): polynomial in both, whatever the pattern.
 */
function matches(c: Compiled, path: string[], isDir: boolean): boolean {
  const P = c.segments.length;
  const N = path.length;
  // reach[j]: the pattern segments consumed so far match path[0..j).
  let reach = new Array<boolean>(N + 1).fill(false);
  reach[0] = true;
  for (let i = 0; i < P; i++) {
    const seg = c.segments[i] as Segment;
    const next = new Array<boolean>(N + 1).fill(false);
    if (seg === '**') {
      let any = false;
      for (let j = 0; j <= N; j++) {
        any = any || (reach[j] as boolean);
        next[j] = any; // zero or more whole segments
      }
    } else {
      for (let j = 0; j < N; j++) if (reach[j] && matchName(seg, path[j] as string)) next[j + 1] = true;
    }
    reach = next;
  }
  for (let k = 1; k <= N; k++) {
    if (!reach[k]) continue;
    if (k < N) return true; // a directory of the path matched: everything below it is covered
    if (!c.dirOnly || isDir) return true; // the path itself matched
  }
  return false;
}

/** File names that define how checks run: never ignored, so a pattern like "*.json" cannot hide a config change. */
const ALWAYS_INPUT_NAMES = new Set([
  '.isitdone.json', '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', '.browserslistrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions',
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'bunfig.toml', 'deno.json', 'deno.jsonc', 'deno.lock',
  'turbo.json', 'nx.json', 'lerna.json', 'rush.json', 'project.json', 'jsconfig.json', 'biome.json', 'biome.jsonc', 'dprint.json', '.swcrc',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'pytest.ini', 'conftest.py', 'noxfile.py', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'mypy.ini', '.mypy.ini', 'ruff.toml', '.ruff.toml', '.flake8', '.pylintrc', 'pylintrc', '.coveragerc', '.pre-commit-config.yaml',
  'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml', 'clippy.toml', '.clippy.toml', 'rustfmt.toml', '.rustfmt.toml', 'deny.toml',
  'Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', '.justfile', 'Taskfile.yml', 'Taskfile.yaml', 'CMakeLists.txt', 'CMakePresets.json', 'meson.build', 'BUILD', 'BUILD.bazel', 'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel', '.bazelrc', '.bazelversion',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradle-wrapper.properties', 'pom.xml',
  'Gemfile', 'Gemfile.lock', '.rspec', '.rubocop.yml', 'composer.json', 'composer.lock', 'phpunit.xml', 'phpunit.xml.dist', 'phpstan.neon', 'global.json', 'nuget.config', 'NuGet.Config', 'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
]);
const ALWAYS_INPUT_PATTERNS = [
  /^tsconfig.*\.json$/,
  /^jest[\w.-]*\.json$/, // jest.config.json, NestJS test/jest-e2e.json
  /^requirements.*\.(txt|in)$/,
  /^[\w.-]+\.(config|conf|workspace)\.[\w.]+$/, // vitest.config.ts, vitest.e2e.config.ts, karma.conf.js, vitest.workspace.ts
  /^\.[\w.-]*(rc|ignore)(\.[\w]+)?$/, // .eslintrc.json, .prettierrc, .babelrc, .mocharc.yml, .eslintignore, .prettierignore
  /^\.(golangci|goreleaser|markdownlint|yamllint|stylelint|lintstaged|c8|nyc)[\w.-]*$/,
  /^\.env(\..+)?$/,
  /\.(csproj|fsproj|vbproj|sln|props|targets)$/,
];
/** Path prefixes and directory forms, relative to the project root. */
const ALWAYS_INPUT_PATHS = [/^\.github\/workflows\//, /(^|\/)\.cargo\/config(\.toml)?$/, /(^|\/)requirements\/[^/]+\.(txt|in)$/, /(^|\/)\.mvn\//, /(^|\/)gradle\/wrapper\//];

function alwaysInput(rel: string): boolean {
  if (ALWAYS_INPUT_PATHS.some((r) => r.test(rel))) return true;
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return name !== '' && (ALWAYS_INPUT_NAMES.has(name) || ALWAYS_INPUT_PATTERNS.some((r) => r.test(name)));
}

/**
 * A predicate over git paths (relative to the repository top-level, forward slashes): is this path ignored by the
 * patterns? `prefix` is the project root relative to the top-level ("" or "sub/dir/"); paths outside it never match.
 * A directory entry (a submodule or an embedded repository) is passed with a trailing slash. Never throws: a pattern
 * that cannot be compiled matches nothing.
 */
export function ignoreMatcher(patterns: string[], prefix: string): (path: string) => boolean {
  const compiled: Compiled[] = [];
  for (const p of patterns) {
    if (ignorePatternError(p) !== null) continue;
    try {
      compiled.push(compile(p));
    } catch {
      // matches nothing
    }
  }
  return (path) => {
    if (prefix !== '' && !path.startsWith(prefix)) return false;
    const rel = path.slice(prefix.length);
    if (rel === '' || alwaysInput(rel)) return false;
    const isDir = rel.endsWith('/');
    const segs = rel.split('/').filter((x) => x !== '');
    return segs.length > 0 && compiled.some((c) => matches(c, segs, isDir));
  };
}
