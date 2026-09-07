import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getHost, HOSTS } from '../src/hosts.js';
import { ensureGitignore, init, installedHooks } from '../src/init.js';
import { nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

describe('init', () => {
  it('adds a Claude Code Stop hook idempotently and preserves other settings', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const path = join(repo.root, '.claude', 'settings.json');
    repo.write('.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    const first = init({ root: repo.root, hosts: ['claude'], scope: 'project' });
    expect(first.map((r) => [r.host, r.action])).toEqual([['claude', 'added']]);
    const s = read(path);
    expect(s.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect((s.hooks as Record<string, unknown>).PreToolUse).toBeDefined();
    const stop = (s.hooks as Record<string, unknown[]>).Stop as Array<{ hooks: Array<{ command: string; timeout: number; type: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]?.hooks[0]).toEqual({ type: 'command', command: 'npx -y isitdone hook --host claude', timeout: 600 });
    const again = init({ root: repo.root, hosts: ['claude'], scope: 'project' });
    expect(again[0]?.action).toBe('unchanged');
    expect(((read(path).hooks as Record<string, unknown[]>).Stop as unknown[]).length).toBe(1);
    const updated = init({ root: repo.root, hosts: ['claude'], scope: 'project', timeout: 120 });
    expect(updated[0]?.action).toBe('updated');
    expect(((read(path).hooks as Record<string, unknown[]>).Stop as Array<{ hooks: Array<{ timeout: number }> }>)[0]?.hooks[0]?.timeout).toBe(120);
    expect(installedHooks(repo.root).map((h) => h.host.name)).toEqual(['claude']);
  });

  it('removes only the isitdone hook and cleans up empty containers', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const path = join(repo.root, '.claude', 'settings.json');
    repo.write('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } }));
    init({ root: repo.root, hosts: ['claude'], scope: 'project' });
    const removed = init({ root: repo.root, hosts: ['claude'], scope: 'project', remove: true });
    expect(removed[0]?.action).toBe('removed');
    const s = read(path);
    expect(JSON.stringify(s)).not.toContain('isitdone');
    expect(JSON.stringify(s)).toContain('echo other');
    expect(init({ root: repo.root, hosts: ['claude'], scope: 'project', remove: true })[0]?.action).toBe('absent');
    // removing the last hook drops the empty hooks object entirely
    repo.write('.claude/settings.json', JSON.stringify({ theme: 'dark' }));
    init({ root: repo.root, hosts: ['claude'], scope: 'project' });
    init({ root: repo.root, hosts: ['claude'], scope: 'project', remove: true });
    expect(read(path)).toEqual({ theme: 'dark' });
  });

  it('writes host-specific shapes for codex, cursor and gemini', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    const results = init({ root, hosts: ['codex', 'cursor', 'gemini'], scope: 'project', timeout: 120 });
    expect(results.map((r) => r.action)).toEqual(['added', 'added', 'added']);

    const codex = read(join(repo.root, '.codex', 'hooks.json'));
    expect(codex).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npx -y isitdone hook --host codex', timeout: 120 }] }] } });

    const cursor = read(join(repo.root, '.cursor', 'hooks.json'));
    expect(cursor).toEqual({ version: 1, hooks: { stop: [{ command: 'npx -y isitdone hook --host cursor', timeout: 120, loop_limit: 3 }] } });

    const gemini = read(join(repo.root, '.gemini', 'settings.json'));
    expect(gemini).toEqual({ hooks: { AfterAgent: [{ matcher: '*', hooks: [{ name: 'isitdone', type: 'command', command: 'npx -y isitdone hook --host gemini', timeout: 120000 }] }] } });

    expect(installedHooks(root).map((h) => h.host.name)).toEqual(['codex', 'cursor', 'gemini']);
    for (const name of ['codex', 'cursor', 'gemini'] as const) {
      expect(init({ root, hosts: [name], scope: 'project', timeout: 120 })[0]?.action).toBe('unchanged');
      expect(init({ root, hosts: [name], scope: 'project', remove: true })[0]?.action).toBe('removed');
    }
    expect(installedHooks(root)).toEqual([]);
  });

  it('auto mode picks hosts with a settings dir in the repo, defaulting to claude, never the home dir', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    // A user-level Codex dir must NOT be picked up by auto mode.
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    mkdirSync(join(home, '.codex'), { recursive: true });
    const none = init({ root: repo.root, hosts: 'auto', scope: 'project' });
    expect(none.map((r) => [r.host, r.scope])).toEqual([['claude', 'project']]);
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);

    const withCodex = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }), '.codex/config.toml': '' } });
    try {
      const r = init({ root: withCodex.root, hosts: 'auto', scope: 'project' });
      expect(r.map((x) => [x.host, x.scope])).toEqual([['codex', 'project']]);
    } finally {
      withCodex.cleanup();
    }
  });

  it('supports a custom command and a BOM-prefixed existing file', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const path = join(repo.root, '.codex', 'hooks.json');
    repo.write('.codex/hooks.json', String.fromCharCode(0xfeff) + '{"hooks":{}}');
    const r = init({ root: repo.root, hosts: ['codex'], scope: 'project', command: (h) => `node /abs/cli.js hook --host ${h.name}` });
    expect(r[0]?.command).toBe('node /abs/cli.js hook --host codex');
    const text = readFileSync(path, 'utf8');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).toContain('node /abs/cli.js hook --host codex');
  });

  it('refuses to overwrite an unparsable settings file', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    repo.write('.claude/settings.json', '{ broken');
    expect(() => init({ root, hosts: ['claude'], scope: 'project' })).toThrow(/not valid JSON/);
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe('{ broken');
  });
});

describe('ensureGitignore', () => {
  it('adds .isitdone/ once, without clobbering', () => {
    repo = tempRepo({ files: { '.gitignore': 'node_modules' } });
    expect(ensureGitignore(repo.root)).toBe('added');
    expect(readFileSync(join(repo.root, '.gitignore'), 'utf8')).toBe('node_modules\n.isitdone/\n');
    expect(ensureGitignore(repo.root)).toBe('present');
    writeFileSync(join(repo.root, '.gitignore'), '/.isitdone\n');
    expect(ensureGitignore(repo.root)).toBe('present');
  });
  it('creates .gitignore when missing and skips non-repos', () => {
    repo = tempRepo({ files: { 'a.txt': 'a' } });
    expect(existsSync(join(repo.root, '.gitignore'))).toBe(false);
    expect(ensureGitignore(repo.root)).toBe('added');
    const plain = tempRepo({ git: false, files: { 'a.txt': 'a' } });
    try {
      expect(ensureGitignore(plain.root)).toBe('skipped');
    } finally {
      plain.cleanup();
    }
  });
});

describe('host adapters', () => {
  it('parse the documented payload shapes', () => {
    const c = HOSTS.claude.parse({ session_id: 'a', cwd: '/r', stop_hook_active: true, last_assistant_message: 'hi', background_tasks: [{}, {}] });
    expect(c).toMatchObject({ sessionId: 'a', cwd: '/r', stopHookActive: true, lastMessage: 'hi', backgroundTasks: 2 });
    const x = HOSTS.codex.parse({ session_id: 'a', cwd: '/r', stop_hook_active: false, last_assistant_message: null });
    expect(x).toMatchObject({ sessionId: 'a', lastMessage: null, stopHookActive: false });
    const u = HOSTS.cursor.parse({ conversation_id: 'c', workspace_roots: ['/w'], status: 'completed', loop_count: 2 });
    expect(u).toMatchObject({ sessionId: 'c', cwd: '/w', status: 'completed', loopCount: 2, stopHookActive: true, lastMessage: null });
    const g = HOSTS.gemini.parse({ session_id: 'g', cwd: '/r', prompt_response: 'done', stop_hook_active: false });
    expect(g).toMatchObject({ sessionId: 'g', lastMessage: 'done' });
  });
  it('getHost rejects unknown names', () => {
    expect(() => getHost('vim')).toThrow(/unknown host/);
  });
});
