import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { looksBlocked } from '../src/doctor.js';
import { detectHosts, getHost, HOST_NAMES, HOSTS, type HostName } from '../src/hosts.js';
import { init, installedHooks, resolveHosts } from '../src/init.js';
import { nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
const DONE = 'Done. All tests pass.';
const CMD = (h: string) => `npx -y @aivolution/isitdone hook --host ${h}`;

/** Every JSON-settings host that can be installed at project scope. */
const PROJECT_JSON_HOSTS: HostName[] = ['copilot', 'qwen', 'goose', 'droid', 'devin', 'augment'];
// Auggie executes script files, so the registered command is the wrapper path (which forwards to the isitdone command).
const AUG_CMD = process.platform === 'win32' ? '.augment\\hooks\\isitdone-hook.cmd' : '.augment/hooks/isitdone-hook.sh';

describe('new host adapters: payload and output shapes', () => {
  it('copilot: camelCase payload, snake_case flag, decision allow/block, no last message', () => {
    const h = HOSTS.copilot;
    const p = h.parse({ sessionId: 'c1', timestamp: 1, cwd: '/r', transcriptPath: '/t.jsonl', stopReason: 'end_turn', stop_hook_active: true });
    expect(p).toMatchObject({ sessionId: 'c1', cwd: '/r', lastMessage: null, stopHookActive: true, status: null, loopCount: null });
    expect(h.parse({ session_id: 's2' }).sessionId).toBe('s2');
    expect(JSON.parse(h.allow())).toEqual({ decision: 'allow' });
    expect(JSON.parse(h.allow('note'))).toEqual({ decision: 'allow', reason: 'note' });
    expect(JSON.parse(h.block('why'))).toEqual({ decision: 'block', reason: 'why' });
    expect(h.event).toBe('agentStop');
  });

  it('qwen: Claude-shaped Stop payload, {} on allow, block, ms timeouts', () => {
    const h = HOSTS.qwen;
    const p = h.parse({ session_id: 'q', cwd: '/r', stop_hook_active: false, last_assistant_message: DONE, background_tasks: [{}], crons: [] });
    expect(p).toMatchObject({ sessionId: 'q', cwd: '/r', lastMessage: DONE, stopHookActive: false, backgroundTasks: 1 });
    expect(h.allow()).toBe('{}');
    expect(JSON.parse(h.allow('m'))).toEqual({ systemMessage: 'm' });
    expect(JSON.parse(h.block('why'))).toEqual({ decision: 'block', reason: 'why' });
    expect(h.msTimeouts).toBe(true);
  });

  it('goose: event key, no cwd, no continuation flag (null), empty allow', () => {
    const h = HOSTS.goose;
    const p = h.parse({ event: 'Stop', session_id: 'g', matcher_context: {}, last_assistant_message: DONE });
    expect(p).toMatchObject({ sessionId: 'g', cwd: null, lastMessage: DONE, stopHookActive: null, hookEventName: 'Stop' });
    // a future flag would be honoured
    expect(h.parse({ session_id: 'g', stop_hook_active: true }).stopHookActive).toBe(true);
    expect(h.allow()).toBe('');
    expect(h.allow('ignored')).toBe('');
    expect(JSON.parse(h.block('why'))).toEqual({ decision: 'block', reason: 'why' });
  });

  it('droid: Claude envelope without a last message, FACTORY_PROJECT_DIR fallback', () => {
    const h = HOSTS.droid;
    const p = h.parse({ session_id: 'd', cwd: '/r', permission_mode: 'default', stop_hook_active: true, tool_execution_count: 2, elapsed_time: 5, message_id: 'm1' });
    expect(p).toMatchObject({ sessionId: 'd', turnId: 'm1', cwd: '/r', lastMessage: null, stopHookActive: true, permissionMode: 'default' });
    process.env.FACTORY_PROJECT_DIR = '/from-env';
    try {
      expect(h.parse({ session_id: 'd' }).cwd).toBe('/from-env');
    } finally {
      delete process.env.FACTORY_PROJECT_DIR;
    }
    expect(h.allow()).toBe('');
    expect(JSON.parse(h.block('why'))).toEqual({ decision: 'block', reason: 'why' });
  });

  it('devin: session_id + prompt_id only, DEVIN_PROJECT_DIR as cwd', () => {
    const h = HOSTS.devin;
    expect(h.parse({ hook_event_name: 'Stop', session_id: 'v', prompt_id: 'p1', stop_hook_active: false })).toMatchObject({ sessionId: 'v', turnId: 'p1', cwd: null, lastMessage: null, stopHookActive: false });
    process.env.DEVIN_PROJECT_DIR = '/devin-root';
    try {
      expect(h.parse({ session_id: 'v' }).cwd).toBe('/devin-root');
      expect(h.edit!.parse({ tool_name: 'edit', tool_input: { file_path: 'a.ts' } })).toEqual({ files: ['a.ts'], cwd: '/devin-root', toolName: 'edit' });
      // the shared Claude registration runs under Devin too
      expect(HOSTS.claude.parse({ session_id: 'v', stop_hook_active: false }).cwd).toBe('/devin-root');
    } finally {
      delete process.env.DEVIN_PROJECT_DIR;
    }
    expect(JSON.parse(h.block('why'))).toEqual({ decision: 'block', reason: 'why' });
    expect(h.coveredBy).toBe('claude');
  });

  it('augment: Cursor-like payload, agent_stop_cause as status, nested block, no flag', () => {
    const h = HOSTS.augment;
    const p = h.parse({ hook_event_name: 'Stop', conversation_id: 'a', workspace_roots: ['/w'], agent_stop_cause: 'end_turn', conversation: { userPrompt: 'x', agentTextResponse: DONE, agentCodeResponse: [] } });
    expect(p).toMatchObject({ sessionId: 'a', cwd: '/w', lastMessage: DONE, status: 'completed', stopHookActive: null });
    expect(h.parse({ conversation_id: 'a', workspace_roots: ['/w'], agent_stop_cause: 'interrupted' }).status).toBe('interrupted');
    expect(h.parse({ conversation_id: 'a', workspace_roots: ['/w'] })).toMatchObject({ lastMessage: null, status: null });
    expect(h.allow()).toBe('');
    expect(JSON.parse(h.block('why'))).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason: 'why' } });
    expect(looksBlocked(h, { exitCode: 0, stdout: h.block('why'), stderr: '', durationMs: 1, timedOut: false }).blocked).toBe(true);
    expect(looksBlocked(h, { exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: 'top-level is wrong for augment' }), stderr: '', durationMs: 1, timedOut: false }).blocked).toBe(false);
  });

  it('opencode: shim payload, worktree fallback, camelCase edit args and patchText', () => {
    const h = HOSTS.opencode;
    const p = h.parse({ hook_event_name: 'session.idle', session_id: 'o', message_id: 'm', cwd: '/sub', worktree: '/w', last_assistant_message: DONE, stop_hook_active: true, loop_count: 1 });
    expect(p).toMatchObject({ sessionId: 'o', turnId: 'm', cwd: '/sub', lastMessage: DONE, stopHookActive: true, loopCount: null });
    expect(h.parse({ session_id: 'o', worktree: '/w' }).cwd).toBe('/w');
    expect(h.kind).toBe('file');
    expect(h.edit!.parse({ tool_name: 'edit', tool_input: { filePath: '/w/a.test.ts', oldString: 'a', newString: 'b' }, cwd: '/w' }).files).toEqual(['/w/a.test.ts']);
    expect(h.edit!.parse({ tool_name: 'apply_patch', tool_input: { patchText: '*** Begin Patch\n*** Update File: src/x.test.ts\n@@\n-a\n+b\n*** End Patch\n' }, worktree: '/w' })).toEqual({ files: ['src/x.test.ts'], cwd: '/w', toolName: 'apply_patch' });
    expect(JSON.parse(h.edit!.warn('note')).hookSpecificOutput).toEqual({ hookEventName: 'tool.execute.after', additionalContext: 'note' });
    expect(h.allow()).toBe('');
    expect(JSON.parse(h.block('why'))).toEqual({ decision: 'block', reason: 'why' });
  });

  it('junie: three stdin fields, user scope only, experimental display name', () => {
    const h = HOSTS.junie;
    expect(h.parse({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: DONE })).toMatchObject({ sessionId: null, cwd: null, lastMessage: DONE, stopHookActive: true });
    expect(h.scopes).toEqual(['user']);
    expect(h.displayName).toMatch(/early access/);
    expect(h.allow()).toBe('');
    expect(JSON.parse(h.block('why'))).toEqual({ decision: 'block', reason: 'why' });
  });

  it('claude: the flag means nothing under Continue (cn), which hard-codes stop_hook_active: true', () => {
    expect(HOSTS.claude.parse({ session_id: 'c', cwd: '/r', stop_hook_active: true }).stopHookActive).toBe(true);
    process.env.CONTINUE_PROJECT_DIR = '/r';
    try {
      expect(HOSTS.claude.parse({ session_id: 'c', cwd: '/r', stop_hook_active: true }).stopHookActive).toBeNull();
    } finally {
      delete process.env.CONTINUE_PROJECT_DIR;
    }
    expect(HOSTS.claude.postInstallNote).toMatch(/Continue \(cn\)/);
    expect(HOSTS.claude.postInstallNote).toMatch(/Devin/);
  });

  it('every host has a synthetic payload its own parser understands and a doctor-recognised block', () => {
    for (const name of HOST_NAMES) {
      const h = HOSTS[name];
      const input = h.parse(h.synthetic('/root', DONE));
      expect(input.hookEventName === null || input.hookEventName === h.event).toBe(true);
      // the doctor must recognise this host's block shape
      expect(looksBlocked(h, { exitCode: 0, stdout: h.block('NOT DONE'), stderr: '', durationMs: 1, timedOut: false }).blocked).toBe(true);
      expect(looksBlocked(h, { exitCode: 0, stdout: h.allow(), stderr: '', durationMs: 1, timedOut: false }).blocked).toBe(false);
      if (h.edit) {
        const e = h.edit.parse(h.edit.synthetic('/root', 'src/a.test.ts'));
        expect(e.files.length).toBe(1);
      }
    }
  });
});

describe('init for the new hosts', () => {
  it('writes each host-specific file shape once, updates in place, and removes only itself', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    const r = init({ editHook: false, root, hosts: PROJECT_JSON_HOSTS, scope: 'project', timeout: 120 });
    expect(r.map((x) => `${x.host}:${x.action}`)).toEqual(PROJECT_JSON_HOSTS.map((h) => `${h}:added`));

    expect(read(join(root, '.github', 'hooks', 'isitdone.json'))).toEqual({ version: 1, hooks: { agentStop: [{ type: 'command', bash: CMD('copilot'), powershell: CMD('copilot'), timeoutSec: 120 }] } });
    expect(read(join(root, '.qwen', 'settings.json'))).toEqual({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: CMD('qwen'), timeout: 120000, name: 'isitdone' }] }] } });
    expect(read(join(root, '.agents', 'plugins', 'isitdone', 'hooks', 'hooks.json'))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD('goose'), timeout: 120 }] }] } });
    // Droid and Devin project files carry the event map at the top level
    expect(read(join(root, '.factory', 'hooks.json'))).toEqual({ Stop: [{ hooks: [{ type: 'command', command: CMD('droid'), timeout: 120 }] }] });
    expect(read(join(root, '.devin', 'hooks.v1.json'))).toEqual({ Stop: [{ hooks: [{ type: 'command', command: CMD('devin'), timeout: 120 }] }] });
    expect(read(join(root, '.augment', 'settings.json'))).toEqual({ hooks: { Stop: [{ metadata: { includeConversationData: true }, hooks: [{ type: 'command', command: AUG_CMD, timeout: 120000 }] }] } });

    const installed = installedHooks(root);
    expect(installed.map((h) => `${h.host.name}:${h.timeout}`)).toEqual(PROJECT_JSON_HOSTS.map((h) => `${h}:120`));

    for (const name of PROJECT_JSON_HOSTS) {
      expect(init({ editHook: false, root, hosts: [name], scope: 'project', timeout: 120 })[0]?.action).toBe('unchanged');
      expect(init({ editHook: false, root, hosts: [name], scope: 'project', timeout: 300 })[0]?.action).toBe('updated');
      expect(installedHooks(root).find((h) => h.host.name === name)?.timeout).toBe(300);
      expect(init({ editHook: false, root, hosts: [name], scope: 'project', remove: true })[0]?.action).toBe('removed');
      expect(init({ editHook: false, root, hosts: [name], scope: 'project', remove: true })[0]?.action).toBe('absent');
    }
    expect(installedHooks(root)).toEqual([]);
    // removal leaves nothing but empty objects behind
    // ... except for files whose empty shell would do harm: Droid keeps masking settings.json, Copilot would be schema-invalid.
    expect(existsSync(join(root, '.github', 'hooks', 'isitdone.json'))).toBe(false);
    expect(existsSync(join(root, '.factory', 'hooks.json'))).toBe(false);
    expect(read(join(root, '.augment', 'settings.json'))).toEqual({});
    expect(existsSync(join(root, '.augment', 'hooks', 'isitdone-hook.sh'))).toBe(false);
  });

  it('augment: user-added metadata keys survive a re-init, a missing includeConversationData is restored', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    const path = join(root, '.augment', 'settings.json');
    repo.write('.augment/settings.json', JSON.stringify({ hooks: { Stop: [{ metadata: { includeUserContext: true }, hooks: [{ type: 'command', command: AUG_CMD, timeout: 120000 }] }] } }));
    expect(init({ editHook: false, root, hosts: ['augment'], scope: 'project', timeout: 120 })[0]?.action).toBe('updated');
    expect((read(path).hooks as { Stop: Array<{ metadata: unknown }> }).Stop[0]?.metadata).toEqual({ includeUserContext: true, includeConversationData: true });
    expect(init({ editHook: false, root, hosts: ['augment'], scope: 'project', timeout: 120 })[0]?.action).toBe('unchanged');
  });

  it('keeps foreign hooks in the same files', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    repo.write('.github/hooks/isitdone.json', JSON.stringify({ version: 1, hooks: { agentStop: [{ type: 'command', bash: 'echo other' }], sessionStart: [{ type: 'command', bash: 'echo hi' }] } }));
    repo.write('.factory/hooks.json', JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] }));
    init({ editHook: false, root, hosts: ['copilot', 'droid'], scope: 'project', timeout: 120 });
    init({ editHook: false, root, hosts: ['copilot', 'droid'], scope: 'project', remove: true });
    expect(read(join(root, '.github', 'hooks', 'isitdone.json'))).toEqual({ version: 1, hooks: { agentStop: [{ type: 'command', bash: 'echo other' }], sessionStart: [{ type: 'command', bash: 'echo hi' }] } });
    expect(read(join(root, '.factory', 'hooks.json'))).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] });
  });

  it('devin: edit hook at project scope, nested "hooks" wrapper at user scope, skipped when the Claude hook covers it', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    const r = init({ root, hosts: ['devin'], scope: 'project', timeout: 120 });
    expect(r.map((x) => `${x.event}:${x.action}`)).toEqual(['stop:added', 'edit:added']);
    const project = read(join(root, '.devin', 'hooks.v1.json')) as { Stop: unknown[]; PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }> };
    expect(project.PostToolUse[0]?.matcher).toBe('^(edit|write|apply_patch|notebook_edit)$');
    expect(project.PostToolUse[0]?.hooks[0]).toEqual({ type: 'command', command: `${CMD('devin')} --event edit`, timeout: 30 });
    expect(project.Stop).toHaveLength(1);
    expect(installedHooks(root).map((h) => `${h.host.name}:${h.event}`)).toEqual(['devin:stop', 'devin:edit']);

    const user = init({ editHook: false, root, hosts: ['devin'], scope: 'user', timeout: 120 });
    expect(user[0]?.action).toBe('added');
    const userPath = user[0]?.path as string;
    expect(userPath.startsWith(join(homedir(), 'AppData', 'Roaming')) || userPath.startsWith(join(homedir(), '.config'))).toBe(true);
    expect(read(userPath)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD('devin'), timeout: 120 }] }] } });
    expect(init({ editHook: false, root, hosts: ['devin'], scope: 'user', timeout: 120 })[0]?.action).toBe('unchanged');
    expect(init({ editHook: false, root, hosts: ['devin'], scope: 'user', remove: true }).map((x) => `${x.scope}:${x.event}:${x.action}`)).toEqual(['project:stop:removed', 'project:edit:removed', 'user:stop:removed']);
    expect(read(userPath)).toEqual({});
    rmSync(dirname(userPath), { recursive: true, force: true }); // keep the fake home clean for the detection test below

    // Devin loads .claude/settings.json too: with the Claude hook present, devin is skipped and nothing is written
    init({ editHook: false, root, hosts: ['claude'], scope: 'project', timeout: 120 });
    const covered = init({ editHook: false, root, hosts: ['devin'], scope: 'project', timeout: 120 });
    expect(covered[0]?.action).toBe('skipped');
    expect(covered[0]?.note).toMatch(/also loads .*\.claude.*settings\.json.*twice/);
    expect(read(join(root, '.devin', 'hooks.v1.json'))).toEqual({}); // left as the uninstall left it
    expect(installedHooks(root).map((h) => h.host.name)).toEqual(['claude']);
  });

  it('junie: user scope only; project scope is an error when named, skipped under "all"', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    expect(() => init({ editHook: false, root, hosts: ['junie'], scope: 'project', timeout: 120 })).toThrow(/only from .*\.junie.*config\.json.*--user/);
    expect(existsSync(join(root, '.junie'))).toBe(false);
    const r = init({ editHook: false, root, hosts: ['junie'], scope: 'user', timeout: 120 });
    expect(r[0]?.action).toBe('added');
    expect(r[0]?.path).toBe(join(homedir(), '.junie', 'config.json'));
    expect(read(r[0]?.path as string)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD('junie'), timeout: 120 }] }] } });
    expect(installedHooks(root).map((h) => `${h.host.name}:${h.scope}`)).toEqual(['junie:user']);
    expect(init({ editHook: false, root, hosts: ['junie'], scope: 'user', remove: true })[0]?.action).toBe('removed');
  });

  it('"all" at project scope in a repo with none of the dirs: writes every project-capable host, skips devin (covered) and junie', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    const r = init({ editHook: false, root, hosts: 'all', scope: 'project', timeout: 120 });
    expect(r.map((x) => `${x.host}:${x.action}`)).toEqual([
      'claude:added',
      'codex:added',
      'cursor:added',
      'gemini:added',
      'copilot:added',
      'qwen:added',
      'goose:added',
      'droid:added',
      'devin:skipped',
      'augment:added',
      'opencode:added',
      'junie:skipped',
    ]);
    expect(existsSync(join(root, '.opencode', 'plugins', 'isitdone.js'))).toBe(true);
    expect(existsSync(join(root, '.devin'))).toBe(false);
    expect(existsSync(join(root, '.junie'))).toBe(false);
    expect(installedHooks(root).every((h) => h.scope === 'project')).toBe(true);
    // idempotent, and the skips repeat rather than turning into writes
    expect(init({ editHook: false, root, hosts: 'all', scope: 'project', timeout: 120 }).map((x) => x.action)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'skipped', 'unchanged', 'unchanged', 'skipped']);
    const removed = init({ editHook: false, root, hosts: 'all', scope: 'project', remove: true });
    expect(removed.every((x) => x.action === 'removed')).toBe(true);
    expect(removed.map((x) => x.host)).toEqual(['claude', 'codex', 'cursor', 'gemini', 'copilot', 'qwen', 'goose', 'droid', 'augment', 'opencode']);
    expect(installedHooks(root)).toEqual([]);
  });

  it('auto mode detects the new hosts by their dirs, at project and user scope separately', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }), '.qwen/settings.json': '{}', '.factory/config.json': '{}', '.opencode/opencode.json': '{}', '.github/hooks/other.json': '{}' } });
    const root = repo.root;
    mkdirSync(join(homedir(), '.junie'), { recursive: true });
    mkdirSync(join(homedir(), '.augment'), { recursive: true });
    const project = detectHosts(root, existsSync);
    expect(project.map((f) => `${f.host.name}:${f.scope}`)).toEqual(['copilot:project', 'qwen:project', 'droid:project', 'augment:user', 'opencode:project', 'junie:user']);
    expect(resolveHosts(root, 'auto', 'project').map((t) => t.host.name)).toEqual(['copilot', 'qwen', 'droid', 'opencode']);
    expect(resolveHosts(root, 'auto', 'user').map((t) => t.host.name)).toEqual(['augment', 'junie']);
    // a bare .github (workflows) is not a Copilot hooks dir; opencode.json at the root is enough for OpenCode
    const plain = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }), '.github/workflows/ci.yml': '', 'opencode.json': '{}' } });
    try {
      expect(detectHosts(plain.root, existsSync).map((f) => f.host.name)).toEqual(['augment', 'opencode', 'junie']);
    } finally {
      plain.cleanup();
    }
    const r = init({ editHook: false, root, hosts: 'auto', scope: 'project', timeout: 120 });
    expect(r.map((x) => `${x.host}:${x.action}`)).toEqual(['copilot:added', 'qwen:added', 'droid:added', 'opencode:added']);
    // nothing was written at user scope
    expect(installedHooks(root).map((h) => `${h.host.name}:${h.scope}`)).toEqual(['copilot:project', 'qwen:project', 'droid:project', 'opencode:project']);
  });

  it('getHost knows every name and rejects the rest', () => {
    for (const n of HOST_NAMES) expect(getHost(n).name).toBe(n);
    expect(() => getHost('continue')).toThrow(/unknown host/);
  });

  it('refuses to overwrite a foreign hooks.json for goose or an unparsable copilot file', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    const p = join(root, '.github', 'hooks', 'isitdone.json');
    mkdirSync(join(root, '.github', 'hooks'), { recursive: true });
    writeFileSync(p, '{ nope');
    expect(() => init({ editHook: false, root, hosts: ['copilot'], scope: 'project' })).toThrow(/not valid JSON/);
    expect(readFileSync(p, 'utf8')).toBe('{ nope');
  });
});
