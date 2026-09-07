import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckKind, IsitdoneConfig } from './config.js';

export interface Check {
  /** Stable id: test, typecheck, lint, build, or a custom key from config. */
  id: string;
  /** Shell command. */
  cmd: string;
  kind: CheckKind;
  /** Where the check came from: package.json, pyproject.toml, go.mod, Cargo.toml, Makefile, config. */
  source: string;
  /** Timeout override in seconds. */
  timeout?: number;
  /** Working directory relative to root. */
  cwd?: string;
}

export interface Detection {
  checks: Check[];
  /** Human-readable notes about what was detected or skipped. */
  notes: string[];
  /** Detected stacks, e.g. ["node", "python"]. */
  stacks: string[];
}

const KIND_BY_ID: Record<string, CheckKind> = {
  test: 'full',
  build: 'full',
  typecheck: 'lite',
  lint: 'lite',
  check: 'lite',
  vet: 'lite',
};

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno';

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function has(root: string, ...names: string[]): boolean {
  return names.some((n) => existsSync(join(root, n)));
}

function detectPackageManager(root: string, pkg: PackageJson): PackageManager {
  const pm = pkg.packageManager?.split('@')[0];
  if (pm === 'pnpm' || pm === 'yarn' || pm === 'bun' || pm === 'npm') return pm;
  if (has(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(root, 'yarn.lock')) return 'yarn';
  if (has(root, 'bun.lockb', 'bun.lock')) return 'bun';
  if (has(root, 'deno.json', 'deno.jsonc')) return 'deno';
  return 'npm';
}

function runScript(pm: PackageManager, script: string): string {
  if (script === 'test' && pm !== 'deno') return `${pm} test`;
  if (pm === 'npm') return `npm run ${script}`;
  if (pm === 'deno') return `deno task ${script}`;
  return `${pm} run ${script}`;
}

const NPM_DEFAULT_TEST = /echo\s+["']?Error: no test specified/i;

function hasDep(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

function detectNode(root: string, out: Detection, config: IsitdoneConfig): void {
  const pkgFile = join(root, 'package.json');
  if (!existsSync(pkgFile)) return;
  const pkg = readJson<PackageJson>(pkgFile);
  if (!pkg) {
    out.notes.push('package.json could not be parsed');
    return;
  }
  out.stacks.push('node');
  const pm = detectPackageManager(root, pkg);
  const scripts = pkg.scripts ?? {};
  const push = (id: string, cmd: string, source = 'package.json') =>
    out.checks.push({ id, cmd, kind: KIND_BY_ID[id] ?? 'full', source });

  const isWatchMode = (s: string) => /\bwatch\b/.test(s) || /\bnodemon\b/.test(s);

  if (scripts.test && !NPM_DEFAULT_TEST.test(scripts.test) && !isWatchMode(scripts.test)) {
    push('test', runScript(pm, 'test'));
  } else if (scripts.test && NPM_DEFAULT_TEST.test(scripts.test)) {
    out.notes.push('package.json "test" script is the npm placeholder; no test check');
  }

  const typecheckScript = ['typecheck', 'type-check', 'types', 'tsc', 'check-types', 'check:types'].find((s) => scripts[s]);
  if (typecheckScript) {
    push('typecheck', runScript(pm, typecheckScript));
  } else if (has(root, 'tsconfig.json') && hasDep(pkg, 'typescript')) {
    push('typecheck', pm === 'deno' ? 'deno check .' : 'npx tsc --noEmit', 'tsconfig.json');
  }

  const lintScript = ['lint', 'eslint', 'check:lint'].find((s) => scripts[s]);
  if (lintScript) push('lint', runScript(pm, lintScript));

  if (scripts.build && !isWatchMode(scripts.build)) {
    const hasOther = out.checks.some((c) => c.id === 'test' || c.id === 'typecheck');
    if (config.build === true || !hasOther) {
      push('build', runScript(pm, 'build'));
    } else {
      out.notes.push('build script found but skipped (set "build": true in .isitdone.json to include it)');
    }
  }
}

function hasPyTool(pyproject: string, tool: string): boolean {
  return new RegExp(`^\\[tool\\.${tool}(\\.|\\])`, 'm').test(pyproject);
}

function hasPyDep(pyproject: string, requirements: string, name: string): boolean {
  const re = new RegExp(`["'\\s]${name}(\\[[^\\]]*\\])?\\s*([<>=!~;\\s"']|$)`, 'im');
  return re.test(pyproject) || re.test(requirements);
}

function detectPython(root: string, out: Detection): void {
  const pyproject = readText(join(root, 'pyproject.toml'));
  const hasPy = pyproject !== '' || has(root, 'setup.py', 'setup.cfg', 'requirements.txt', 'pytest.ini', 'tox.ini', 'Pipfile');
  if (!hasPy) return;
  out.stacks.push('python');
  const requirements = ['requirements.txt', 'requirements-dev.txt', 'requirements/dev.txt', 'dev-requirements.txt']
    .map((f) => readText(join(root, f)))
    .join('\n');
  const setupCfg = readText(join(root, 'setup.cfg'));
  const runner = has(root, 'uv.lock') ? 'uv run ' : has(root, 'poetry.lock') ? 'poetry run ' : has(root, 'Pipfile.lock') ? 'pipenv run ' : '';
  const push = (id: string, cmd: string, source: string) =>
    out.checks.push({ id, cmd: runner + cmd, kind: KIND_BY_ID[id] ?? 'full', source });

  const pytestConfigured =
    has(root, 'pytest.ini', 'conftest.py') ||
    hasPyTool(pyproject, 'pytest') ||
    /^\[tool:pytest\]/m.test(setupCfg) ||
    /^\[pytest\]/m.test(readText(join(root, 'tox.ini'))) ||
    hasPyDep(pyproject, requirements, 'pytest');
  const testsDir = ['tests', 'test'].find((d) => {
    try {
      return statSync(join(root, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (pytestConfigured || testsDir) {
    push('test', 'pytest -q', pytestConfigured ? 'pytest config' : `${testsDir}/ directory`);
  }

  if (has(root, 'ruff.toml', '.ruff.toml') || hasPyTool(pyproject, 'ruff') || hasPyDep(pyproject, requirements, 'ruff')) {
    push('lint', 'ruff check .', 'ruff config');
  } else if (has(root, '.flake8') || /^\[flake8\]/m.test(setupCfg) || hasPyDep(pyproject, requirements, 'flake8')) {
    push('lint', 'flake8', 'flake8 config');
  }

  if (has(root, 'mypy.ini', '.mypy.ini') || hasPyTool(pyproject, 'mypy') || /^\[mypy\]/m.test(setupCfg) || hasPyDep(pyproject, requirements, 'mypy')) {
    push('typecheck', 'mypy .', 'mypy config');
  } else if (has(root, 'pyrightconfig.json') || hasPyTool(pyproject, 'pyright') || hasPyDep(pyproject, requirements, 'pyright')) {
    push('typecheck', 'pyright', 'pyright config');
  }
}

function detectGo(root: string, out: Detection): void {
  if (!has(root, 'go.mod')) return;
  out.stacks.push('go');
  out.checks.push({ id: 'vet', cmd: 'go vet ./...', kind: 'lite', source: 'go.mod' });
  out.checks.push({ id: 'test', cmd: 'go test ./...', kind: 'full', source: 'go.mod' });
}

function detectRust(root: string, out: Detection): void {
  if (!has(root, 'Cargo.toml')) return;
  out.stacks.push('rust');
  out.checks.push({ id: 'check', cmd: 'cargo check --all-targets', kind: 'lite', source: 'Cargo.toml' });
  out.checks.push({ id: 'test', cmd: 'cargo test', kind: 'full', source: 'Cargo.toml' });
}

function detectDotnet(root: string, out: Detection): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const hasProject = entries.some((e) => /\.(sln|slnx|csproj|fsproj)$/i.test(e));
  if (!hasProject) return;
  out.stacks.push('dotnet');
  out.checks.push({ id: 'build', cmd: 'dotnet build --nologo -v q', kind: 'lite', source: 'dotnet project' });
  out.checks.push({ id: 'test', cmd: 'dotnet test --nologo -v q --no-build', kind: 'full', source: 'dotnet project' });
}

function detectJvm(root: string, out: Detection): void {
  if (has(root, 'build.gradle', 'build.gradle.kts')) {
    out.stacks.push('gradle');
    const wrapper = has(root, 'gradlew') ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew') : 'gradle';
    out.checks.push({ id: 'test', cmd: `${wrapper} test -q`, kind: 'full', source: 'build.gradle' });
  } else if (has(root, 'pom.xml')) {
    out.stacks.push('maven');
    const wrapper = has(root, 'mvnw') ? (process.platform === 'win32' ? 'mvnw.cmd' : './mvnw') : 'mvn';
    out.checks.push({ id: 'test', cmd: `${wrapper} -q -B test`, kind: 'full', source: 'pom.xml' });
  }
}

function detectMakefile(root: string, out: Detection): void {
  const mk = readText(join(root, 'Makefile')) || readText(join(root, 'makefile'));
  if (!mk) return;
  const targets = new Set<string>();
  for (const m of mk.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) targets.add(m[1] as string);
  if (targets.size === 0) return;
  out.stacks.push('make');
  const want: Array<[string, string[]]> = [
    ['test', ['test', 'tests', 'check']],
    ['lint', ['lint']],
    ['typecheck', ['typecheck', 'type-check', 'mypy']],
  ];
  for (const [id, names] of want) {
    if (out.checks.some((c) => c.id === id)) continue;
    const t = names.find((n) => targets.has(n));
    if (t) out.checks.push({ id, cmd: `make ${t}`, kind: KIND_BY_ID[id] ?? 'full', source: 'Makefile' });
  }
}

function applyConfig(out: Detection, config: IsitdoneConfig): void {
  if (!config.checks) return;
  for (const [id, value] of Object.entries(config.checks)) {
    const existing = out.checks.findIndex((c) => c.id === id);
    if (value === false) {
      if (existing >= 0) out.checks.splice(existing, 1);
      out.notes.push(`check "${id}" disabled by config`);
      continue;
    }
    const cfg = typeof value === 'string' ? { cmd: value } : value;
    const check: Check = {
      id,
      cmd: cfg.cmd,
      kind: cfg.kind ?? (existing >= 0 ? (out.checks[existing] as Check).kind : (KIND_BY_ID[id] ?? 'full')),
      source: 'config',
    };
    if (cfg.timeout !== undefined) check.timeout = cfg.timeout;
    if (cfg.cwd !== undefined) check.cwd = cfg.cwd;
    if (existing >= 0) out.checks[existing] = check;
    else out.checks.push(check);
  }
}

/** Order checks: lite first (fast feedback), then full. Stable within kind. */
function order(checks: Check[]): Check[] {
  const rank = (c: Check) => (c.kind === 'lite' ? 0 : 1);
  return [...checks].sort((a, b) => rank(a) - rank(b));
}

export function detectChecks(root: string, config: IsitdoneConfig = {}): Detection {
  const out: Detection = { checks: [], notes: [], stacks: [] };
  detectNode(root, out, config);
  detectPython(root, out);
  detectGo(root, out);
  detectRust(root, out);
  detectDotnet(root, out);
  detectJvm(root, out);
  detectMakefile(root, out);
  applyConfig(out, config);
  out.checks = order(out.checks);
  return out;
}
