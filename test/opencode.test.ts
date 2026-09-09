import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OPENCODE_FOLLOWUP_MARKER, OPENCODE_PLUGIN_MARKER, parseOpencodePlugin, renderOpencodePlugin } from '../src/opencode-plugin.js';
import { init, installedHooks } from '../src/init.js';
import { FAIL, PASS, nodePkg, tempRepo, type TempRepo } from './helpers.js';

// Own bundle path so this file never races cli.test.ts, which builds into test/.build/isitdone.js.
const BUNDLE = resolve('test/.build/isitdone-opencode.js');

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

const LOCAL_HOOK = `"${process.execPath}" "${BUNDLE}" hook --host opencode`;

/**
 * Loads the generated plugin under real Node ESM with a fake OpenCode client, fires one hook, and prints what the
 * plugin did. Runs in a child so the shim's `import` is resolved by Node, not by vitest's transformer.
 */
const DRIVER = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[2]).href);
const scenario = JSON.parse(readFileSync(process.argv[3], "utf8"));
const calls = [];
const client = {
  app: { log: async () => ({}) },
  session: {
    get: async () => ({ data: { id: "s1", parentID: scenario.parentID } }),
    messages: async () => ({ data: scenario.messages }),
    promptAsync: async (o) => { calls.push(o); return {}; },
  },
};
const hooks = await mod.IsItDone({ client, directory: scenario.directory, worktree: scenario.directory });
if (scenario.tool) {
  const output = { title: "", output: "ok", metadata: {} };
  await hooks["tool.execute.after"]({ tool: scenario.tool, sessionID: "s1", callID: "c1", args: scenario.args }, output);
  console.log(JSON.stringify({ output: output.output, hasEdit: true }));
} else {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  console.log(JSON.stringify({ calls, hasEdit: typeof hooks["tool.execute.after"] === "function" }));
}
`;

interface Msg {
  info: { id: string; role: 'user' | 'assistant'; error?: unknown };
  parts: Array<{ type: string; text?: string }>;
}
const user = (id: string, text: string): Msg => ({ info: { id, role: 'user' }, parts: [{ type: 'text', text }] });
const assistant = (id: string, text: string, error?: unknown): Msg => ({ info: { id, role: 'assistant', ...(error ? { error } : {}) }, parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text }] });

function drive(root: string, scenario: Record<string, unknown>, editHook = true): { calls: Array<{ path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }>; output?: string; hasEdit: boolean } {
  const dir = join(root, '.isitdone-shim');
  mkdirSync(dir, { recursive: true });
  const plugin = join(dir, 'isitdone.mjs'); // .mjs so plain Node parses the ESM shim without a package.json
  writeFileSync(plugin, renderOpencodePlugin({ stopCommand: LOCAL_HOOK, editCommand: editHook ? `${LOCAL_HOOK} --event edit` : null, timeoutSeconds: 60, editTimeoutSeconds: 30 }));
  const driver = join(dir, 'driver.mjs');
  writeFileSync(driver, DRIVER);
  const scenarioFile = join(dir, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify({ directory: root, ...scenario }));
  const r = spawnSync(process.execPath, [driver, plugin, scenarioFile], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, windowsHide: true, timeout: 90_000 });
  if (r.status !== 0) throw new Error(`driver failed (${r.status}): ${r.stderr}`);
  const last = r.stdout.trim().split('\n').pop() as string;
  return JSON.parse(last) as ReturnType<typeof drive>;
}

describe('OpenCode plugin shim', () => {
  it('renders plain ESM JavaScript that Node parses, and reads its own constants back', () => {
    const text = renderOpencodePlugin({ stopCommand: 'npx -y @aivolution/isitdone hook --host opencode', editCommand: 'npx -y @aivolution/isitdone hook --host opencode --event edit', timeoutSeconds: 600, editTimeoutSeconds: 30 });
    expect(text.startsWith(OPENCODE_PLUGIN_MARKER)).toBe(true);
    expect(text).not.toMatch(/require\(|from ['"](?!node:)/); // no dependencies
    repo = tempRepo({ git: false, files: { 'isitdone.mjs': text } });
    const check = spawnSync(process.execPath, ['--check', join(repo.root, 'isitdone.mjs')], { encoding: 'utf8', windowsHide: true });
    expect(check.status, check.stderr).toBe(0);
    expect(parseOpencodePlugin(text)).toEqual({ stopCommand: 'npx -y @aivolution/isitdone hook --host opencode', editCommand: 'npx -y @aivolution/isitdone hook --host opencode --event edit', timeoutSeconds: 600 });
    // quoting survives a command with backslashes and quotes (Windows node path)
    const tricky = renderOpencodePlugin({ stopCommand: '"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\isitdone.js" hook --host opencode', editCommand: null, timeoutSeconds: 90, editTimeoutSeconds: 30 });
    expect(parseOpencodePlugin(tricky)).toEqual({ stopCommand: '"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\isitdone.js" hook --host opencode', editCommand: null, timeoutSeconds: 90 });
    writeFileSync(join(repo.root, 'tricky.mjs'), tricky);
    expect(spawnSync(process.execPath, ['--check', join(repo.root, 'tricky.mjs')], { encoding: 'utf8', windowsHide: true }).status).toBe(0);
    expect(parseOpencodePlugin('export const Other = async () => ({})')).toBeNull();
    expect(parseOpencodePlugin('')).toBeNull();
  });

  it('re-prompts the session with the report when the checks fail, and derives stop_hook_active from its own follow-ups', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    const first = drive(repo.root, { messages: [user('u1', 'fix the bug'), assistant('a1', 'Done. All tests pass.')] });
    expect(first.hasEdit).toBe(true);
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]?.path).toEqual({ id: 's1' });
    const text = first.calls[0]?.body.parts[0]?.text ?? '';
    expect(text.startsWith(`${OPENCODE_FOLLOWUP_MARKER} `)).toBe(true);
    expect(text).toMatch(/NOT DONE/);
    expect(text).toMatch(/attempt 1\/3/);
    // the agent answered our follow-up: the trailing "[isitdone]" message makes this a continuation
    const second = drive(repo.root, { messages: [user('u1', 'fix the bug'), assistant('a1', 'Done.'), user('u2', text), assistant('a2', 'Fixed it. Tests pass now.')] });
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.body.parts[0]?.text).toMatch(/attempt 2\/3/);
    // a new user prompt after our follow-ups is a fresh turn again
    const fresh = drive(repo.root, { messages: [user('u1', 'fix'), assistant('a1', 'Done.'), user('u2', text), assistant('a2', 'Fixed.'), user('u3', 'now add docs'), assistant('a3', 'Done. Docs added and all tests pass.')] });
    expect(fresh.calls[0]?.body.parts[0]?.text).toMatch(/attempt 1\/3/);
  });

  it('stays quiet for subagent sessions, aborted turns, and passing checks', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    const msgs = [user('u1', 'go'), assistant('a1', 'Done. All tests pass.')];
    expect(drive(repo.root, { messages: msgs, parentID: 'parent' }).calls).toEqual([]);
    expect(drive(repo.root, { messages: [user('u1', 'go'), assistant('a1', '', { name: 'MessageAbortedError' })] }).calls).toEqual([]);
    expect(drive(repo.root, { messages: [user('u1', 'go')] }).calls).toEqual([]);
    repo.write('package.json', nodePkg({ test: PASS }));
    expect(drive(repo.root, { messages: msgs }).calls).toEqual([]);
  });

  it('appends the edit-hook note to the tool result after a weakening edit, and only for edit tools', () => {
    const TEST = "it('adds', () => { expect(add(1, 1)).toBe(2); });\nit('subtracts', () => { expect(sub(2, 1)).toBe(1); });\n";
    repo = tempRepo({ files: { 'src/math.test.ts': TEST, 'package.json': nodePkg({ test: PASS }) } });
    const file = join(repo.root, 'src', 'math.test.ts');
    const quiet = drive(repo.root, { tool: 'edit', args: { filePath: file, oldString: 'a', newString: 'b' } });
    expect(quiet.output).toBe('ok');
    repo.write('src/math.test.ts', TEST.replace("it('adds'", "it.skip('adds'"));
    const noted = drive(repo.root, { tool: 'edit', args: { filePath: file, oldString: 'a', newString: 'b' } });
    expect(noted.output).toMatch(/^ok\n\n.*src\/math\.test\.ts has weaker tests/);
    const patch = drive(repo.root, { tool: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Update File: src/math.test.ts\n@@\n-a\n+b\n*** End Patch\n' } });
    expect(patch.output).toMatch(/weaker tests/);
    expect(drive(repo.root, { tool: 'read', args: { filePath: file } }).output).toBe('ok');
    // without an edit command the shim registers no tool hook at all
    expect(drive(repo.root, { messages: [user('u1', 'go')] }, false).hasEdit).toBe(false);
  });
});

describe('init --agent opencode owns the plugin file', () => {
  it('writes, updates, and removes .opencode/plugins/isitdone.js idempotently; never touches a foreign file', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const root = repo.root;
    const path = join(root, '.opencode', 'plugins', 'isitdone.js');
    const r = init({ root, hosts: ['opencode'], scope: 'project', timeout: 120 });
    expect(r.map((x) => `${x.event}:${x.action}:${x.hostEvent}`)).toEqual(['stop:added:session.idle', 'edit:added:tool.execute.after']);
    expect(r[0]?.path).toBe(path);
    expect(r[0]?.note).toMatch(/visible "\[isitdone\] \.\.\." user message/);
    expect(r[0]?.note).toMatch(/opencode run/);
    const text = readFileSync(path, 'utf8');
    expect(parseOpencodePlugin(text)).toEqual({ stopCommand: 'npx -y @aivolution/isitdone hook --host opencode', editCommand: 'npx -y @aivolution/isitdone hook --host opencode --event edit', timeoutSeconds: 120 });
    expect(installedHooks(root).map((h) => `${h.host.name}:${h.event}:${h.timeout}`)).toEqual(['opencode:stop:120', 'opencode:edit:30']);

    expect(init({ root, hosts: ['opencode'], scope: 'project', timeout: 120 }).map((x) => x.action)).toEqual(['unchanged', 'unchanged']);
    expect(init({ root, hosts: ['opencode'], scope: 'project', timeout: 300 }).map((x) => x.action)).toEqual(['updated', 'updated']);
    expect(parseOpencodePlugin(readFileSync(path, 'utf8'))?.timeoutSeconds).toBe(300);
    // --no-edit-hook keeps an existing edit hook
    expect(init({ root, hosts: ['opencode'], scope: 'project', timeout: 300, editHook: false }).map((x) => x.action)).toEqual(['unchanged', 'unchanged']);

    const removed = init({ root, hosts: ['opencode'], scope: 'project', remove: true });
    expect(removed.map((x) => `${x.event}:${x.action}`)).toEqual(['stop:removed', 'edit:removed']);
    expect(existsSync(path)).toBe(false);
    expect(init({ root, hosts: ['opencode'], scope: 'project', remove: true })[0]?.action).toBe('absent');

    // a stop-only shim reports no edit hook
    init({ root, hosts: ['opencode'], scope: 'project', timeout: 120, editHook: false });
    expect(installedHooks(root).map((h) => h.event)).toEqual(['stop']);
    init({ root, hosts: ['opencode'], scope: 'project', remove: true });

    // somebody else's plugin with our file name is left alone
    repo.write('.opencode/plugins/isitdone.js', 'export const Mine = async () => ({})\n');
    const foreign = init({ root, hosts: ['opencode'], scope: 'project', timeout: 120 });
    expect(foreign[0]?.action).toBe('skipped');
    expect(foreign[0]?.note).toMatch(/not generated by isitdone/);
    expect(readFileSync(path, 'utf8')).toBe('export const Mine = async () => ({})\n');
    expect(installedHooks(root)).toEqual([]);
    expect(init({ root, hosts: ['opencode'], scope: 'project', remove: true })[0]?.action).toBe('absent');
    expect(existsSync(path)).toBe(true);
  });

  it('user scope lands in the XDG config dir', () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'x' }) } });
    const r = init({ editHook: false, root: repo.root, hosts: ['opencode'], scope: 'user', timeout: 120 });
    expect(r[0]?.path).toBe(join(process.env.HOME as string, '.config', 'opencode', 'plugins', 'isitdone.js'));
    expect(existsSync(r[0]?.path as string)).toBe(true);
    expect(init({ editHook: false, root: repo.root, hosts: ['opencode'], scope: 'user', remove: true })[0]?.action).toBe('removed');
  });
});
