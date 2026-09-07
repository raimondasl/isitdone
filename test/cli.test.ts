import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FAIL, PASS, nodePkg, tempRepo, type TempRepo } from './helpers.js';

// Built into test/.build so the test never clobbers the real dist/ bundle (which carries the real version).
const BUNDLE = resolve('test/.build/isitdone.js');

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

beforeAll(async () => {
  const { build } = await import('esbuild');
  await build({
    entryPoints: ['src/cli.ts'],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    define: { __VERSION__: '"0.0.0-test"' },
    logLevel: 'silent',
  });
}, 60_000);

function cli(args: string[], cwd: string, stdin?: string) {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, encoding: 'utf8', input: stdin, env: { ...process.env, NO_COLOR: '1', ISITDONE_DEBUG: '' }, windowsHide: true, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Hook command that runs this bundle directly, so doctor probes work without npm/npx. */
const LOCAL_HOOK = (host: string) => `"${process.execPath}" "${BUNDLE}" hook --host ${host}`;

describe('cli end-to-end', () => {
  it('--version and --help', () => {
    expect(cli(['--version'], process.cwd()).stdout.trim()).toBe('0.0.0-test');
    const h = cli(['--help'], process.cwd());
    expect(h.code).toBe(0);
    expect(h.stdout).toMatch(/npx isitdone init/);
    expect(cli(['bogus'], process.cwd()).code).toBe(3);
    const unknown = cli(['--nope'], process.cwd());
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toMatch(/unknown option --nope/);
  });

  it('refuses to run nested inside its own check, but the hook stays harmless', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    const nested = spawnSync(process.execPath, [BUNDLE], { cwd: repo.root, encoding: 'utf8', env: { ...process.env, ISITDONE: '1' }, windowsHide: true });
    expect(nested.status).toBe(3);
    expect(nested.stderr).toMatch(/nested/);
    const hook = spawnSync(process.execPath, [BUNDLE, 'hook', '--host', 'claude'], { cwd: repo.root, encoding: 'utf8', input: '{}', env: { ...process.env, ISITDONE: '1' }, windowsHide: true });
    expect(hook.status).toBe(0);
    expect(hook.stdout.trim()).toBe('');
  });

  it('run: NOT DONE exits 1, DONE exits 0, receipt reflects it, --json is stable', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL, lint: PASS }) } });
    const bad = cli([], repo.root);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/NOT DONE/);
    expect(bad.stdout).toMatch(/npm test\s+FAIL/);
    expect(cli(['receipt'], repo.root).stdout).toMatch(/FAIL/);

    repo.write('package.json', nodePkg({ test: PASS, lint: PASS }));
    const good = cli([], repo.root);
    expect(good.code).toBe(0);
    expect(good.stdout).toMatch(/DONE\s+receipt -> PASS/);
    const receipt = cli(['receipt'], repo.root);
    expect(receipt.code).toBe(0);
    expect(receipt.stdout).toMatch(/PASS/);
    const md = cli(['receipt', '--md'], repo.root).stdout;
    expect(md).toMatch(/^\| check \| result \| time \|/);
    expect(md).toMatch(/Receipt: \*\*PASS\*\*/);

    const json = JSON.parse(cli(['--json'], repo.root).stdout);
    expect(json.done).toBe(true);
    expect(json.cached).toBe(true);
    expect(json.checks.map((c: { id: string }) => c.id)).toEqual(['lint', 'test']);

    const detect = JSON.parse(cli(['detect', '--json'], repo.root).stdout);
    expect(detect.checks.map((c: { cmd: string }) => c.cmd)).toEqual(['npm run lint', 'npm test']);
  });

  it('hook: reads stdin and blocks with host-specific JSON', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    const payload = JSON.stringify({ session_id: 's', cwd: repo.root, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'All tests pass.' });
    const r = cli(['hook', '--host', 'claude'], repo.root, payload);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.decision).toBe('block');
    expect(json.reason).toMatch(/NOT DONE/);
    expect(cli(['hook'], repo.root, payload).code).toBe(3);
    // garbage stdin never breaks the agent
    expect(cli(['hook', '--host', 'codex'], repo.root, 'garbage').code).toBe(0);
  });

  it('init + doctor: installs the hook, proves it blocks, and uninstalls', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    const r = cli(['init', '--agent', 'claude,codex', '--command', LOCAL_HOOK('claude'), '--no-latest'], repo.root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Claude Code\s+added/);
    expect(r.stdout).toMatch(/Codex CLI\s+added/);
    expect(r.stdout).toMatch(/probe:claude\s+synthetic "tests pass" stop was blocked/);
    expect(r.stdout).toMatch(/probe:codex\s+synthetic "tests pass" stop was blocked/);
    expect(r.stdout).toMatch(/\bOK\b/);
    expect(existsSync(join(repo.root, '.claude', 'settings.json'))).toBe(true);
    expect(readFileSync(join(repo.root, '.gitignore'), 'utf8')).toMatch(/\.isitdone\//);
    // doctor did not leave a receipt or state behind
    expect(existsSync(join(repo.root, '.isitdone', 'receipt.json'))).toBe(false);

    const d = cli(['doctor', '--json', '--no-latest'], repo.root);
    const report = JSON.parse(d.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c: { name: string }) => c.name === 'probe:claude').detail).toMatch(/hook runs isitdone 0\.0\.0-test/);
    expect(report.checks.some((c: { name: string }) => c.name === 'hook:claude')).toBe(true);

    const u = cli(['uninstall', '--agent', 'claude,codex'], repo.root);
    expect(u.code).toBe(0);
    expect(u.stdout).toMatch(/Claude Code\s+removed/);
    expect(JSON.parse(readFileSync(join(repo.root, '.claude', 'settings.json'), 'utf8'))).toEqual({});
  });

  it('doctor flags a repo with no hook and no checks', () => {
    repo = tempRepo({ files: { 'README.md': 'x' } });
    const d = cli(['doctor', '--json', '--no-latest'], repo.root);
    expect(d.code).toBe(1);
    const report = JSON.parse(d.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c: { name: string }) => c.name === 'checks').ok).toBe(false);
    expect(report.checks.find((c: { name: string }) => c.name === 'hooks').ok).toBe(false);
  });
});
