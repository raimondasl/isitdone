import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEditHook, runHook } from '../src/hook.js';
import { HOSTS, patchPaths } from '../src/hosts.js';
import { init, installedHooks } from '../src/init.js';
import { nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const TEST = "it('adds', () => { expect(add(1, 1)).toBe(2); });\nit('subtracts', () => { expect(sub(2, 1)).toBe(1); });\n";
const WEAKER = "it.skip('adds', () => { expect(add(1, 1)).toBe(2); });\nit('subtracts', () => { expect(sub(2, 1)).toBe(1); });\n";

describe('runEditHook', () => {
  it('claude: warns through additionalContext after a weakening edit, stays silent otherwise', () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'package.json': nodePkg({ test: 'x' }) } });
    const file = join(repo.root, 'src', 'math.test.ts');
    const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: 's', cwd: repo!.root, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, tool_response: { filePath: file, success: true }, tool_use_id: 't1', ...extra });
    expect(runEditHook({ host: 'claude', stdin: payload() }).stdout).toBe('');
    repo.write('src/math.test.ts', WEAKER);
    const o = runEditHook({ host: 'claude', stdin: payload() });
    const json = JSON.parse(o.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(json.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(json.hookSpecificOutput.additionalContext).toMatch(/after your edit, src\/math\.test\.ts has weaker tests than HEAD/);
    expect(json.hookSpecificOutput.additionalContext).toMatch(/test skipped/);
    expect(o.notes).toHaveLength(1);
  });

  it('codex: finds the files inside the apply_patch text', () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'package.json': nodePkg({ test: 'x' }) } });
    repo.write('src/math.test.ts', WEAKER);
    const patch = `*** Begin Patch\n*** Update File: src/math.test.ts\n@@\n-it('adds'\n+it.skip('adds'\n*** End Patch\n`;
    const o = runEditHook({ host: 'codex', stdin: JSON.stringify(HOSTS.codex.edit!.synthetic(repo.root, 'src/math.test.ts')), cwd: repo.root });
    expect(JSON.parse(o.stdout).hookSpecificOutput.additionalContext).toMatch(/src\/math\.test\.ts/);
    expect(patchPaths(patch)).toEqual(['src/math.test.ts']);
    expect(patchPaths('*** Begin Patch\n*** Add File: a.py\n+x\n*** Delete File: b.py\n*** Update File: c.py\n*** Move to: d.py\n@@\n-1\n+2\n*** End Patch')).toEqual(['a.py', 'b.py', 'd.py']);
  });

  it('codex: a relative apply_patch path is resolved against the session cwd, not the repository top', () => {
    repo = tempRepo({ files: { 'packages/app/tests/math.test.ts': TEST, 'tests/math.test.ts': TEST, 'package.json': nodePkg({ test: 'x' }) } });
    repo.write('packages/app/tests/math.test.ts', WEAKER);
    const cwd = join(repo.root, 'packages', 'app');
    const payload = JSON.stringify({ session_id: 's', cwd, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: tests/math.test.ts\n@@\n-a\n+b\n*** End Patch\n' } });
    const o = runEditHook({ host: 'codex', stdin: payload });
    expect(o.notes).toHaveLength(1);
    expect(o.notes[0]).toMatch(/packages\/app\/tests\/math\.test\.ts has weaker tests/);
  });

  it('stays silent when the config turns the integrity scan off', () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'package.json': nodePkg({ test: 'x' }), '.isitdone.json': '{ "integrity": "off" }\n' } });
    repo.write('src/math.test.ts', WEAKER);
    const o = runEditHook({ host: 'claude', stdin: JSON.stringify(HOSTS.claude.edit!.synthetic(repo.root, 'src/math.test.ts')) });
    expect(o.stdout).toBe('');
    expect(o.why).toMatch(/off in config/);
  });

  it('a stop-hook command that receives a tool event handles it as the warn-only edit hook', async () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'package.json': nodePkg({ test: 'node -e "process.exit(1)"' }) } });
    repo.write('src/math.test.ts', WEAKER);
    const o = await runHook({ host: 'claude', stdin: JSON.stringify(HOSTS.claude.edit!.synthetic(repo.root, 'src/math.test.ts')) });
    expect(o.decision).toBe('allow');
    expect(o.why).toMatch(/PostToolUse payload routed to the edit hook/);
    expect(JSON.parse(o.stdout).hookSpecificOutput.additionalContext).toMatch(/has weaker tests/);
    expect(o.result).toBeNull();
  });

  it('gemini: AfterTool shape, {} when silent; cursor has no channel; garbage never throws', () => {
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'package.json': nodePkg({ test: 'x' }) } });
    const quiet = runEditHook({ host: 'gemini', stdin: JSON.stringify(HOSTS.gemini.edit!.synthetic(repo.root, 'src/math.test.ts')) });
    expect(quiet.stdout).toBe('{}');
    repo.write('src/math.test.ts', WEAKER);
    const o = runEditHook({ host: 'gemini', stdin: JSON.stringify(HOSTS.gemini.edit!.synthetic(repo.root, 'src/math.test.ts')) });
    expect(JSON.parse(o.stdout).hookSpecificOutput.hookEventName).toBe('AfterTool');
    // Gemini HTML-escapes the context; the arrows in the summary line must not reach the model as "-&gt;".
    expect(JSON.parse(o.stdout).hookSpecificOutput.additionalContext).not.toMatch(/->/);
    expect(JSON.parse(o.stdout).hookSpecificOutput.additionalContext).toMatch(/Tests 2 → 2/);
    expect(runEditHook({ host: 'cursor', stdin: '{}' }).stdout).toBe('');
    expect(runEditHook({ host: 'claude', stdin: 'not json', cwd: repo.root }).stdout).toBe('');
    expect(runEditHook({ host: 'claude', stdin: '{}', cwd: repo.root }).stdout).toBe('');
    expect(runEditHook({ host: 'claude', stdin: JSON.stringify({ tool_input: { file_path: join(repo.root, 'src', 'math.test.ts') } }), cwd: repo.root, env: { ISITDONE: '1' } }).why).toMatch(/nested/);
  });
});

describe('init registers the edit hook next to the stop hook', () => {
  it('claude, codex and gemini get both; cursor only the stop hook; uninstall removes both', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const r = init({ root: repo.root, hosts: 'all', scope: 'project', timeout: 120 });
    expect(r.map((x) => `${x.host}:${x.event}:${x.action}`)).toEqual(['claude:stop:added', 'claude:edit:added', 'codex:stop:added', 'codex:edit:added', 'cursor:stop:added', 'gemini:stop:added', 'gemini:edit:added']);
    const claude = JSON.parse(readFileSync(join(repo.root, '.claude', 'settings.json'), 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>> };
    expect(claude.hooks.PostToolUse?.[0]?.matcher).toBe('Edit|Write|MultiEdit');
    expect(claude.hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('npx -y @aivolution/isitdone hook --host claude --event edit');
    expect(claude.hooks.PostToolUse?.[0]?.hooks[0]?.timeout).toBe(30);
    expect(claude.hooks.Stop?.[0]?.hooks[0]?.command).toBe('npx -y @aivolution/isitdone hook --host claude');
    const gemini = JSON.parse(readFileSync(join(repo.root, '.gemini', 'settings.json'), 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ name: string; timeout: number }> }>> };
    expect(gemini.hooks.AfterTool?.[0]?.matcher).toBe('write_file|replace');
    expect(gemini.hooks.AfterTool?.[0]?.hooks[0]?.timeout).toBe(30000);
    expect(installedHooks(repo.root).map((h) => `${h.host.name}:${h.event}`)).toEqual(['claude:stop', 'claude:edit', 'codex:stop', 'codex:edit', 'cursor:stop', 'gemini:stop', 'gemini:edit']);
    // idempotent
    expect(init({ root: repo.root, hosts: 'all', scope: 'project', timeout: 120 }).every((x) => x.action === 'unchanged')).toBe(true);
    // --no-edit-hook leaves an existing edit hook alone but does not add one elsewhere
    const removed = init({ root: repo.root, hosts: ['claude'], scope: 'project', remove: true });
    expect(removed.map((x) => `${x.event}:${x.action}`)).toEqual(['stop:removed', 'edit:removed']);
    expect(JSON.parse(readFileSync(join(repo.root, '.claude', 'settings.json'), 'utf8'))).toEqual({});
  });
});
