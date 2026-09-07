import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePayload, readState, resolveProfile, runHook } from '../src/hook.js';
import { HOSTS } from '../src/hosts.js';
import { FAIL, PASS, nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const DONE = 'Done. All 48 tests pass and the auth refactor is complete.';
const QUESTION = 'I looked at the parser. Do you want me to also refactor the tokenizer?';

function claudePayload(root: string, message: string | null, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ session_id: 's1', transcript_path: '/x.jsonl', cwd: root, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message, ...extra });
}

describe('parsePayload', () => {
  it('accepts objects, tolerates BOM, rejects garbage', () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
    expect(parsePayload(String.fromCharCode(0xfeff) + ' {"a":1}\n')).toEqual({ a: 1 });
    expect(parsePayload('')).toBeNull();
    expect(parsePayload('[1]')).toBeNull();
    expect(parsePayload('{"a": "unterminated')).toBeNull();
    expect(parsePayload('not json')).toBeNull();
  });
});

describe('resolveProfile', () => {
  const base = { sessionId: 's', cwd: null, stopHookActive: false, loopCount: null, status: null, backgroundTasks: 0, hookEventName: 'Stop' };
  it('is claim-gated by default', () => {
    expect(resolveProfile({}, { ...base, lastMessage: DONE }).profile).toBe('full');
    expect(resolveProfile({}, { ...base, lastMessage: QUESTION }).profile).toBe('lite');
    expect(resolveProfile({}, { ...base, lastMessage: null }).profile).toBe('full');
  });
  it('honours config and overrides', () => {
    expect(resolveProfile({ profile: 'lite' }, { ...base, lastMessage: DONE }).profile).toBe('lite');
    expect(resolveProfile({ profile: 'full' }, { ...base, lastMessage: QUESTION }).profile).toBe('full');
    expect(resolveProfile({ profile: 'lite' }, { ...base, lastMessage: QUESTION }, 'full').profile).toBe('full');
    expect(resolveProfile({ claimPatterns: ['ship it'] }, { ...base, lastMessage: 'ship it' }).profile).toBe('full');
  });
});

describe('runHook (claude)', () => {
  it('blocks a "tests pass" stop when the tests fail, with a bounded reason', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL, lint: PASS }) } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(o.decision).toBe('block');
    expect(o.exitCode).toBe(0);
    const json = JSON.parse(o.stdout) as { decision: string; reason: string };
    expect(json.decision).toBe('block');
    expect(json.reason).toMatch(/NOT DONE/);
    expect(json.reason).toMatch(/You claimed: "All 48 tests pass/);
    expect(json.reason).toMatch(/npm test\s+FAIL/);
    expect(json.reason.length).toBeLessThan(9000);
    expect(o.attempts).toBe(1);
    expect(readState(repo.root)?.attempts).toBe(1);
    expect(existsSync(join(repo.root, '.isitdone', 'receipt.json'))).toBe(true);
  });

  it('allows when all checks pass and resets attempts', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS, lint: PASS }) } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(o.decision).toBe('allow');
    expect(o.stdout).toBe('');
    expect(o.result?.profile).toBe('full');
    expect(o.result?.ran.map((r) => r.id)).toEqual(['lint', 'test']);
    expect(readState(repo.root)?.attempts).toBe(0);
  });

  it('runs only lite checks when there is no completion claim', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL, lint: PASS }) } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, QUESTION) });
    expect(o.decision).toBe('allow');
    expect(o.result?.profile).toBe('lite');
    expect(o.result?.ran.map((r) => r.id)).toEqual(['lint']);
    expect(o.why).toMatch(/lite checks passed/);
  });

  it('blocks on a lite failure even without a claim', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS, lint: FAIL }) } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, QUESTION) });
    expect(o.decision).toBe('block');
    expect(JSON.parse(o.stdout).reason).not.toMatch(/You claimed/);
  });

  it('uses the cached PASS receipt when nothing changed', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(o.decision).toBe('allow');
    expect(o.result?.cached).toBe(true);
    expect(o.why).toMatch(/cached PASS/);
  });

  it('counts attempts across continuations and gives up after maxAttempts', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), '.isitdone.json': '{"maxAttempts": 2}' } });
    const first = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(first.decision).toBe('block');
    expect(JSON.parse(first.stdout).reason).toMatch(/attempt 1\/2/);
    const second = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, { stop_hook_active: true }) });
    expect(second.decision).toBe('block');
    expect(JSON.parse(second.stdout).reason).toMatch(/attempt 2\/2/);
    const third = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, { stop_hook_active: true }) });
    expect(third.decision).toBe('allow');
    expect(third.why).toMatch(/letting the agent stop/);
    expect(JSON.parse(third.stdout).systemMessage).toMatch(/still failing after 2 attempts/);
    // a fresh turn (stop_hook_active false) starts counting again
    const fresh = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(fresh.decision).toBe('block');
    expect(JSON.parse(fresh.stdout).reason).toMatch(/attempt 1\/2/);
  });

  it('resets attempts for a different session id', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), '.isitdone.json': '{"maxAttempts": 1}' } });
    await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    const other = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, { session_id: 's2', stop_hook_active: true }) });
    expect(other.decision).toBe('block');
  });

  it('allows on malformed stdin, background tasks, and broken config', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    expect((await runHook({ host: 'claude', stdin: '{"last_assistant_message": "unterminated', cwd: repo.root })).decision).toBe('allow');
    expect((await runHook({ host: 'claude', stdin: '', cwd: repo.root })).decision).toBe('allow');
    const bg = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, { background_tasks: [{ id: 't', type: 'shell', status: 'running' }] }) });
    expect(bg.decision).toBe('allow');
    expect(bg.why).toMatch(/background task/);
    repo.write('.isitdone.json', '{ not json');
    const broken = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(broken.decision).toBe('allow');
    expect(JSON.parse(broken.stdout).systemMessage).toMatch(/Could not parse/);
  });

  it('allows when no checks are detected', async () => {
    repo = tempRepo({ files: { 'README.md': 'x' } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(o.decision).toBe('allow');
    expect(o.result?.ran).toEqual([]);
  });

  it('finds the repo root from a subdirectory cwd', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), 'sub/dir/file.txt': 'x' } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(join(repo.root, 'sub', 'dir'), DONE) });
    expect(o.decision).toBe('block');
    expect(o.result?.git.root.replace(/\\/g, '/')).toBe(repo.root.replace(/\\/g, '/'));
  });

  it('tolerates Cursor-shaped input routed through the claude host', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    const stdin = JSON.stringify({ conversation_id: 'c1', hook_event_name: 'stop', workspace_roots: [repo.root], status: 'completed', loop_count: 0 });
    const o = await runHook({ host: 'claude', stdin });
    expect(o.decision).toBe('block');
    expect(o.result?.profile).toBe('full');
  });

  it('doctor mode injects a failing probe and persists nothing', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE), doctor: true });
    expect(o.decision).toBe('block');
    expect(JSON.parse(o.stdout).reason).toMatch(/doctor-probe|simulated failing check/);
    expect(existsSync(join(repo.root, '.isitdone', 'receipt.json'))).toBe(false);
    expect(existsSync(join(repo.root, '.isitdone', 'session.json'))).toBe(false);
  });
});

describe('runHook (other hosts)', () => {
  it('codex: strict block/allow shapes', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    const payload = JSON.stringify(HOSTS.codex.synthetic(repo.root, DONE));
    const blocked = await runHook({ host: 'codex', stdin: payload });
    expect(Object.keys(JSON.parse(blocked.stdout)).sort()).toEqual(['decision', 'reason']);
    repo.write('package.json', nodePkg({ test: PASS }));
    const allowed = await runHook({ host: 'codex', stdin: JSON.stringify(HOSTS.codex.synthetic(repo.root, DONE)) });
    expect(allowed.stdout).toBe('');
    // null last message -> full profile
    const nul = await runHook({ host: 'codex', stdin: JSON.stringify({ ...HOSTS.codex.synthetic(repo.root, DONE), last_assistant_message: null }) });
    expect(nul.result?.profile).toBe('full');
  });

  it('cursor: followup_message on block, {} on allow, skips aborted turns and honours loop_count', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), '.isitdone.json': '{"maxAttempts": 1}' } });
    const blocked = await runHook({ host: 'cursor', stdin: JSON.stringify(HOSTS.cursor.synthetic(repo.root, DONE)) });
    expect(JSON.parse(blocked.stdout).followup_message).toMatch(/NOT DONE/);
    const aborted = await runHook({ host: 'cursor', stdin: JSON.stringify({ ...HOSTS.cursor.synthetic(repo.root, DONE), status: 'aborted' }) });
    expect(aborted.stdout).toBe('{}');
    expect(aborted.why).toMatch(/aborted/);
    const looped = await runHook({ host: 'cursor', stdin: JSON.stringify({ ...HOSTS.cursor.synthetic(repo.root, DONE), loop_count: 1 }) });
    expect(looped.decision).toBe('allow');
  });

  it('gemini: deny on block, {} on allow, ignores "[no response text]"', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL, lint: PASS }) } });
    const blocked = await runHook({ host: 'gemini', stdin: JSON.stringify(HOSTS.gemini.synthetic(repo.root, DONE)) });
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: 'deny' });
    const none = await runHook({ host: 'gemini', stdin: JSON.stringify({ ...HOSTS.gemini.synthetic(repo.root, DONE), prompt_response: '[no response text]' }) });
    expect(none.result?.profile).toBe('full');
    repo.write('package.json', nodePkg({ test: PASS, lint: PASS }));
    const allowed = await runHook({ host: 'gemini', stdin: JSON.stringify(HOSTS.gemini.synthetic(repo.root, DONE)) });
    expect(allowed.stdout).toBe('{}');
  });

  it('rejects unknown hosts', async () => {
    await expect(runHook({ host: 'nope', stdin: '{}' })).rejects.toThrow(/unknown host/);
  });
});

describe('state file', () => {
  it('is JSON inside .isitdone and ignored by git', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    const state = JSON.parse(readFileSync(join(repo.root, '.isitdone', 'session.json'), 'utf8'));
    expect(state.sessionId).toBe('s1');
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});
