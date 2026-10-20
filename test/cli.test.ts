import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function cli(args: string[], cwd: string, stdin?: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, encoding: 'utf8', input: stdin, env: { ...process.env, NO_COLOR: '1', ISITDONE_DEBUG: '', ...env }, windowsHide: true, timeout: 60_000 });
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
    expect(h.stdout).toMatch(/npx isitdone mcp/);
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

  it('pause: refused in an agent shell; pauses a repository or all; hook, run and doctor say so; resume ends it', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), '.gitignore': '.isitdone/\n' } });
    const pauses = join(homedir(), '.isitdone', 'pauses');
    // An empty npm cache, so the stale-copy check looks at nothing on the machine running the tests.
    const cache = mkdtempSync(join(tmpdir(), 'isitdone-npmcache-'));
    // Through process.env, which is case-insensitive on Windows: npm may have set NPM_CONFIG_CACHE for this run.
    const prevCache = process.env.npm_config_cache;
    process.env.npm_config_cache = cache;
    const env = {};
    const outside = mkdtempSync(join(tmpdir(), 'isitdone-nogit-'));
    try {
      for (const marker of [{ CLAUDECODE: '1' }, { CLAUDECODE: '' }, { CURSOR_AGENT: '1' }] as Array<Record<string, string>>) {
        const agent = cli(['pause'], repo.root, undefined, { ...env, ...marker });
        expect(agent.code).toBe(3);
        expect(agent.stderr).toMatch(/the user's switch, and this shell looks like one an agent host started.*If you are the agent: ask the user/);
        expect(agent.stderr).not.toMatch(/CLAUDECODE|CURSOR_AGENT/);
      }
      expect(existsSync(pauses)).toBe(false);
      for (const bad of [['--for', '40d'], ['--until', '2020-01-01'], ['--for', '2h', '--until', '2099-01-01'], ['--for', 'soon'], ['--for'], ['--until', 'friday'], ['--until', '2026-02-30'], ['3h'], ['--until', '2099-10-21', '08:00'], ['--global', '8h'], ['--cwd', join(outside, 'nope')]]) {
        const r = cli(['pause', ...bad], repo.root, undefined, env);
        expect(r.code, bad.join(' ')).toBe(3);
      }
      expect(cli(['pause', '3h'], repo.root, undefined, env).stderr).toMatch(/unexpected argument "3h" \(a length goes after --for/);
      expect(existsSync(pauses)).toBe(false);
      expect(cli(['pause'], outside, undefined, env).stderr).toMatch(/not inside a git repository; add --global/);

      const p = cli(['pause', '--for', '2h'], repo.root, undefined, env);
      expect(p.code).toBe(0);
      expect(p.stdout).toMatch(/isitdone paused {2}in this repository until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC.* \(2 h from now\) {2}.* and its worktrees/);
      expect(p.stdout).toMatch(/Hooks running isitdone 0\.9\.0 or later pick it up at their next stop/);
      expect(readdirSync(pauses).filter((f) => f.startsWith('repo-'))).toHaveLength(1);
      expect(existsSync(join(repo.root, '.isitdone'))).toBe(false);
      const stop = JSON.stringify({ session_id: 's', cwd: repo.root, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done, all tests pass.' });
      const hook = cli(['hook', '--host', 'claude'], repo.root, stop);
      expect(hook.code).toBe(0);
      expect(JSON.parse(hook.stdout).systemMessage).toMatch(/^isitdone is paused in this repository/);
      // By hand, the checks still run.
      const run = cli([], repo.root);
      expect(run.code).toBe(1);
      expect(run.stdout).toMatch(/note: the Stop hook is paused in this repository/);
      const doc = cli(['doctor', '--no-probe', '--no-baseline', '--no-latest'], repo.root);
      expect(doc.stdout).toMatch(/i\s+note:pause\s+the Stop hook is paused in this repository/);
      const resumed = JSON.parse(cli(['resume', '--json'], repo.root).stdout);
      expect(resumed).toMatchObject({ resumed: { scope: 'repo' }, stillPaused: null });
      expect(JSON.parse(cli(['hook', '--host', 'claude'], repo.root, stop).stdout).decision).toBe('block');
      expect(cli(['resume'], repo.root).stdout).toMatch(/no pause for this repository was in force/);

      const g = cli(['pause', '--global', '--until', new Date(Date.now() + 3 * 3_600_000).toISOString()], outside, undefined, env);
      expect(g.code).toBe(0);
      expect(g.stdout).toMatch(/isitdone paused {2}for every repository of this user until/);
      expect(JSON.parse(cli(['hook', '--host', 'claude'], repo.root, stop).stdout).systemMessage).toMatch(/^isitdone is paused for every repository of this user.*resume --global/);
      expect(cli(['resume'], repo.root).stdout).toMatch(/no pause for this repository was in force[\s\S]*still paused for every repository of this user/);
      expect(cli(['resume'], outside).code).toBe(3);
      expect(cli(['resume', '--global'], outside).stdout).toMatch(/isitdone resumed {2}the user-wide pause is over/);
      expect(existsSync(join(pauses, 'global.json'))).toBe(false);

      // A copy of isitdone that predates pauses, cached by npx: pause says the hook may not see it yet.
      const old = join(cache, '_npx', 'abc123');
      mkdirSync(join(old, 'node_modules', '@aivolution', 'isitdone'), { recursive: true });
      writeFileSync(join(old, 'package.json'), JSON.stringify({ dependencies: { '@aivolution/isitdone': '^0.8.2' } }));
      writeFileSync(join(old, 'node_modules', '@aivolution', 'isitdone', 'package.json'), JSON.stringify({ name: '@aivolution/isitdone', version: '0.8.2' }));
      const stale = cli(['pause', '--for', '30m'], repo.root, undefined, env);
      expect(stale.stdout).toMatch(/not in force yet: npx has isitdone 0\.8\.2 cached.*npx isitdone update/);
      expect(stale.stdout).not.toMatch(/pick it up at their next stop/);
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
      if (prevCache === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = prevCache;
      rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
      rmSync(pauses, { recursive: true, force: true });
    }
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
    expect(report.checks.find((c: { name: string }) => c.name === 'baseline').detail).toMatch(/all 1 check passes? on the current tree|all 1 check pass on the current tree/);

    const u = cli(['uninstall', '--agent', 'claude,codex'], repo.root);
    expect(u.code).toBe(0);
    expect(u.stdout).toMatch(/Claude Code\s+removed/);
    expect(JSON.parse(readFileSync(join(repo.root, '.claude', 'settings.json'), 'utf8'))).toEqual({});
  });

  it('init --agent all in a bare repo: every project host gets its file, devin and junie are skipped with a note, uninstall cleans up', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    const r = cli(['init', '--agent', 'all', '--no-doctor'], repo.root);
    expect(r.code).toBe(0);
    for (const name of ['Claude Code', 'Copilot CLI', 'Qwen Code', 'Goose', 'Factory Droid', 'Augment \\(Auggie\\)', 'OpenCode']) expect(r.stdout).toMatch(new RegExp(`${name}\\s+added`));
    expect(r.stdout).toMatch(/Devin\s+skipped/);
    expect(r.stdout).toMatch(/Junie CLI \(early access\)\s+skipped/);
    expect(r.stdout).toMatch(/note: Devin also loads/);
    expect(r.stdout).toMatch(/note: Junie CLI \(early access\) reads hooks only from/);
    expect(existsSync(join(repo.root, '.opencode', 'plugins', 'isitdone.js'))).toBe(true);
    expect(existsSync(join(repo.root, '.github', 'hooks', 'isitdone.json'))).toBe(true);
    expect(existsSync(join(repo.root, '.devin'))).toBe(false);
    expect(cli(['init', '--agent', 'junie'], repo.root).code).toBe(3);
    expect(cli(['init', '--agent', 'continue'], repo.root).stderr).toMatch(/--agent must be one of claude, codex, .*junie, all, auto/);
    const u = cli(['uninstall', '--agent', 'all'], repo.root);
    expect(u.code).toBe(0);
    expect(u.stdout).toMatch(/OpenCode\s+removed/);
    expect(existsSync(join(repo.root, '.opencode', 'plugins', 'isitdone.js'))).toBe(false);
    expect(JSON.parse(cli(['doctor', '--json', '--no-latest', '--no-probe'], repo.root).stdout).checks.find((c: { name: string }) => c.name === 'hooks').hint).toMatch(/copilot, qwen, goose/);
  });

  it('doctor probes prove the plumbing for the new hosts through their own payloads', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    const hosts = ['copilot', 'goose', 'droid', 'devin', 'augment', 'opencode'];
    for (const host of hosts) expect(cli(['init', '--agent', host, '--command', LOCAL_HOOK(host), '--no-doctor'], repo.root).code).toBe(0);
    const d = cli(['doctor', '--json', '--no-latest'], repo.root);
    const report = JSON.parse(d.stdout) as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
    for (const host of hosts) {
      const probe = report.checks.find((c) => c.name === `probe:${host}`);
      expect(probe?.ok, `${host}: ${probe?.detail}`).toBe(true);
      expect(probe?.detail).toMatch(/was blocked/);
    }
    expect(report.checks.find((c) => c.name === 'hook:opencode')?.detail).toMatch(/isitdone\.js/);
    expect(report.ok).toBe(true);
    // the hook binaries answer the raw CLI too
    const augment = cli(['hook', '--host', 'augment'], repo.root, JSON.stringify({ hook_event_name: 'Stop', conversation_id: 'c', workspace_roots: [repo.root], agent_stop_cause: 'end_turn' }));
    expect(augment.code).toBe(0);
    expect(augment.stdout.trim()).toBe(''); // tests pass: allow
  });

  it('doctor and init catch a check that already fails on the untouched tree, and say where the command came from', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL, lint: PASS }) } });
    const d = cli(['doctor', '--json', '--no-latest', '--no-probe'], repo.root);
    expect(d.code).toBe(1);
    const report = JSON.parse(d.stdout);
    const base = report.checks.find((c: { name: string }) => c.name === 'baseline:test');
    expect(base.ok).toBe(false);
    expect(base.detail).toMatch(/npm test FAILS on the current tree before any agent edit [(]detected from package[.]json[)]: exit 1: 1 failed, 2 passed/);
    expect(base.hint).toMatch(/NOT DONE on every stop/);
    expect(base.hint).toMatch(/"checks": [{]"test": "<command>"[}]/);
    expect(report.checks.some((c: { name: string }) => c.name === 'baseline:lint')).toBe(false); // lint passed
    // a dry run: nothing written
    expect(existsSync(join(repo.root, '.isitdone', 'receipt.json'))).toBe(false);
    // --no-baseline skips it
    const skipped = JSON.parse(cli(['doctor', '--json', '--no-latest', '--no-probe', '--no-baseline'], repo.root).stdout);
    expect(skipped.checks.some((c: { name: string }) => c.name.startsWith('baseline'))).toBe(false);
    // init runs doctor, so a misdetected or red check is visible at install time
    const r = cli(['init', '--agent', 'claude', '--command', LOCAL_HOOK('claude'), '--no-latest', '--no-probe'], repo.root);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/baseline:test/);
    expect(r.stdout).toMatch(/ATTENTION/);
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

  it('history: one line per agent, lossy Cursor sessions flagged, --json carries byAgent', () => {
    repo = tempRepo({ files: { 'README.md': 'x' } });
    // A home of its own, and every per-OS transcript location pointed inside it, so the real machine is never scanned.
    const home = mkdtempSync(join(tmpdir(), 'isitdone-history-home-'));
    const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: '', GEMINI_CLI_HOME: '', QWEN_HOME: '' };
    const put = (rel: string, lines: unknown[]) => {
      const p = join(home, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    };
    const at = '2026-09-01T10:00:00.000Z';
    put('.claude/projects/C--work-app/s1.jsonl', [
      { type: 'user', timestamp: at, cwd: '/work/app', message: { role: 'user', content: 'go' } },
      { type: 'assistant', timestamp: at, cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/work/app/a.ts' } }] } },
      { type: 'assistant', timestamp: at, cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', timestamp: at, cwd: '/work/app', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] } },
      { type: 'assistant', timestamp: at, cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. All tests pass.' }] } },
    ]);
    put('.cursor/projects/work-app/agent-transcripts/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111.jsonl', [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\ngo\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: '[REDACTED]' }, { type: 'tool_use', name: 'Write', input: { path: '/work/app/a.ts', contents: 'x' } }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: '[REDACTED]' }, { type: 'tool_use', name: 'Shell', input: { command: 'npm test' } }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Done, tests pass.' }] } },
    ]);
    try {
      const r = cli(['history', '--exclude', 'nothing-matches'], repo.root, undefined, env);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/claude-code\s+1 session\s+1 claim\s+100%\s+verified/);
      expect(r.stdout).toMatch(/cursor\s+1 session\s+1 claim\s+100%\s+verified\s+exit codes unavailable in 1 session/);
      const v = cli(['history', '--verbose'], repo.root, undefined, env).stdout;
      expect(v).toMatch(/VERIFIED .*"Done, tests pass\." {2}\(no exit codes\)/);
      expect(v).toMatch(/VERIFIED .*"All tests pass\."\n/);
      const j = JSON.parse(cli(['history', '--json'], repo.root, undefined, env).stdout);
      expect(j.byAgent).toEqual({ 'claude-code': { sessions: 1, claims: 1, verified: 1 }, cursor: { sessions: 1, claims: 1, verified: 1, lossy: 1 } });
      expect(j.cursorSource).toBe('transcripts');
      expect(j.claims).toBeUndefined();
      expect(cli(['history', '--min', '100'], repo.root, undefined, env).code).toBe(0);
      expect(r.stdout).toMatch(/VERIFIED\s+100%\s+\(2\)/);
      expect(r.stdout).toMatch(/FAILED\s+0%\s+\(0\)/);
      expect(r.stdout).toMatch(/0% of "done" claims \(0 of 2\) had no passing test run/);
      expect(cli(['history', '--until', '2026-08-31'], repo.root, undefined, env).stdout).toMatch(/until 2026-08-31[\s\S]*no completion claims found/);
      expect(cli(['history', '--until', 'someday'], repo.root, undefined, env).code).toBe(3);
      expect(cli(['--help'], repo.root).stdout).toContain('Gemini CLI, Qwen Code and Cursor transcripts');
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
