import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectChecks, isWatchMode, onPath } from '../src/detect.js';
import { nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

function ids(root: string, config = {}) {
  return detectChecks(root, config).checks.map((c) => `${c.id}:${c.cmd}`);
}

const hasMake = process.platform !== 'win32' || onPath('make') !== null || onPath('mingw32-make') !== null;
const makeCmd = process.platform === 'win32' && onPath('make') === null && onPath('mingw32-make') !== null ? 'mingw32-make' : 'make';

describe('detectChecks: node', () => {
  it('finds test, typecheck and lint scripts with npm', () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'tsup' }) } });
    const d = detectChecks(repo.root);
    expect(d.stacks).toEqual(['node']);
    expect(ids(repo.root)).toEqual(['typecheck:npm run typecheck', 'lint:npm run lint', 'test:npm test']);
    expect(d.notes.join(' ')).toMatch(/build script found but skipped/);
  });

  it('uses pnpm/yarn/bun from lockfiles and packageManager (bun runs the script, not its own runner)', () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ test: 'jest', lint: 'eslint .' }), 'pnpm-lock.yaml': '' } });
    expect(ids(repo.root)).toEqual(['lint:pnpm run lint', 'test:pnpm test']);
    repo.write('package.json', nodePkg({ test: 'jest' }, { packageManager: 'yarn@4.0.0' }));
    expect(ids(repo.root)).toEqual(['test:yarn test']);
    repo.write('package.json', nodePkg({ test: 'jest' }, { packageManager: 'bun@1.1.0' }));
    expect(ids(repo.root)).toEqual(['test:bun run test']);
  });

  it('skips the npm placeholder test script and watch-mode scripts, but not negated watch flags', () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ test: 'echo "Error: no test specified" && exit 1', build: 'vite build --watch' }) } });
    const d = detectChecks(repo.root);
    expect(d.checks).toEqual([]);
    expect(d.notes.join(' ')).toMatch(/placeholder/);
    repo.write('package.json', nodePkg({ test: 'vitest --watch' }));
    const w = detectChecks(repo.root);
    expect(w.checks).toEqual([]);
    expect(w.notes.join(' ')).toMatch(/watch mode/);
    repo.write('package.json', nodePkg({ test: 'vitest --watch=false' }));
    expect(ids(repo.root)).toEqual(['test:npm test']);
    expect(isWatchMode('jest --watchAll=false')).toBe(false);
    expect(isWatchMode('vitest --no-watch')).toBe(false);
    expect(isWatchMode('vitest --watch false')).toBe(false);
    expect(isWatchMode('vitest --watch')).toBe(true);
    expect(isWatchMode('nodemon src/index.js')).toBe(true);
  });

  it('infers typecheck from tsconfig + typescript dependency, except for solution-style tsconfigs', () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ test: 'vitest run' }, { devDependencies: { typescript: '^5' } }), 'tsconfig.json': '{ // comment\n "compilerOptions": { "strict": true, }, }' } });
    expect(ids(repo.root)).toEqual(['typecheck:npx tsc --noEmit', 'test:npm test']);
    repo.write('tsconfig.json', '{ "files": [], "references": [{ "path": "packages/api" }] }');
    const d = detectChecks(repo.root);
    expect(d.checks.map((c) => c.id)).toEqual(['test']);
    expect(d.notes.join(' ')).toMatch(/solution-style/);
  });

  it('includes build when nothing else exists, or when configured', () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ build: 'tsc' }) } });
    expect(ids(repo.root)).toEqual(['build:npm run build']);
    repo.write('package.json', nodePkg({ build: 'tsc', test: 'vitest run' }));
    expect(ids(repo.root)).toEqual(['test:npm test']);
    expect(ids(repo.root, { build: true })).toEqual(['test:npm test', 'build:npm run build']);
  });

  it('tolerates a BOM in package.json', () => {
    repo = tempRepo({ git: false, files: { 'package.json': String.fromCharCode(0xfeff) + nodePkg({ test: 'vitest run' }) } });
    expect(ids(repo.root)).toEqual(['test:npm test']);
  });
});

describe('detectChecks: python', () => {
  it('detects pytest, ruff and mypy from pyproject with uv', () => {
    repo = tempRepo({
      git: false,
      files: {
        'pyproject.toml': '[project]\nname = "x"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n',
        'uv.lock': '',
      },
    });
    expect(ids(repo.root)).toEqual(['lint:uv run ruff check .', 'typecheck:uv run mypy .', 'test:uv run pytest -q']);
  });

  it('detects pytest from a tests directory and dev dependencies', () => {
    repo = tempRepo({ git: false, files: { 'requirements.txt': 'flask\npytest>=8\nruff\n', 'tests/test_x.py': '' } });
    expect(ids(repo.root)).toEqual(['lint:ruff check .', 'test:pytest -q']);
  });

  it('prefers poetry when poetry.lock exists', () => {
    repo = tempRepo({ git: false, files: { 'pyproject.toml': '[tool.poetry]\nname="x"\n[tool.poetry.dev-dependencies]\npytest = "^8"\n', 'poetry.lock': '' } });
    expect(ids(repo.root)).toEqual(['test:poetry run pytest -q']);
  });

  it('puts a project .venv on PATH when no virtualenv is active', () => {
    repo = tempRepo({ git: false, files: { 'requirements.txt': 'pytest\n', 'tests/test_x.py': '' } });
    const bin = join(repo.root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
    const saved = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
    try {
      const d = detectChecks(repo.root);
      expect(d.env.VIRTUAL_ENV).toBe(join(repo.root, '.venv'));
      const pathKey = Object.keys(d.env).find((k) => k.toUpperCase() === 'PATH') as string;
      expect(d.env[pathKey]?.startsWith(bin)).toBe(true);
      expect(d.notes.join(' ')).toMatch(/virtualenv/);
      process.env.VIRTUAL_ENV = '/elsewhere';
      expect(detectChecks(repo.root).env.VIRTUAL_ENV).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.VIRTUAL_ENV;
      else process.env.VIRTUAL_ENV = saved;
    }
  });
});

describe('detectChecks: other stacks', () => {
  it('go', () => {
    repo = tempRepo({ git: false, files: { 'go.mod': 'module x\n' } });
    expect(ids(repo.root)).toEqual(['vet:go vet ./...', 'test:go test ./...']);
  });

  it('rust', () => {
    repo = tempRepo({ git: false, files: { 'Cargo.toml': '[package]\nname="x"\n' } });
    expect(ids(repo.root)).toEqual(['check:cargo check --all-targets', 'test:cargo test']);
  });

  it('makefile fills gaps only (or notes that make is missing on Windows)', () => {
    repo = tempRepo({ git: false, files: { Makefile: 'CC := gcc\n\ntest:\n\tgo test\n\nlint:\n\tgolangci-lint run\n', 'go.mod': 'module x\n' } });
    const d = detectChecks(repo.root);
    if (hasMake) {
      expect(d.checks.map((c) => `${c.id}:${c.cmd}`)).toEqual(['vet:go vet ./...', `lint:${makeCmd} lint`, 'test:go test ./...']);
    } else {
      expect(d.checks.map((c) => c.id)).toEqual(['vet', 'test']);
      expect(d.notes.join(' ')).toMatch(/"make" is not on PATH/);
    }
  });

  it('makefile alone', () => {
    repo = tempRepo({ git: false, files: { Makefile: 'all: build\n\ncheck:\n\t./run-tests\n' } });
    const d = detectChecks(repo.root);
    if (hasMake) expect(d.checks.map((c) => `${c.id}:${c.cmd}`)).toEqual([`test:${makeCmd} check`]);
    else expect(d.checks).toEqual([]);
  });

  it('nothing', () => {
    repo = tempRepo({ git: false, files: { 'README.md': 'hi' } });
    expect(detectChecks(repo.root)).toEqual({ checks: [], notes: [], stacks: [], env: {} });
  });
});

describe('detectChecks: config overrides', () => {
  it('replaces, disables and adds checks', () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ test: 'vitest run', lint: 'eslint .' }) } });
    const d = detectChecks(repo.root, {
      checks: {
        test: 'npm run test:unit',
        lint: false,
        e2e: { cmd: 'playwright test', kind: 'full', timeout: 600 },
        smoke: { cmd: './smoke.sh', kind: 'lite' },
      },
    });
    expect(d.checks.map((c) => [c.id, c.cmd, c.kind, c.source, c.timeout])).toEqual([
      ['smoke', './smoke.sh', 'lite', 'config', undefined],
      ['test', 'npm run test:unit', 'full', 'config', undefined],
      ['e2e', 'playwright test', 'full', 'config', 600],
    ]);
    expect(d.notes).toContain('check "lint" disabled by config');
  });
});
