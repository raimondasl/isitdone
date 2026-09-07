import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isContinuation, parsePayload, readState, resolveProfile, runHook, type SessionState } from '../src/hook.js';
import { HOSTS, type HookInput } from '../src/hosts.js';
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

const baseInput: HookInput = { sessionId: 's', turnId: null, cwd: null, lastMessage: null, stopHookActive: false, loopCount: null, status: null, backgroundTasks: 0, permissionMode: null, hookEventName: 'Stop' };
const state = (p: Partial<SessionState>): SessionState => ({ host: 'claude', sessionId: 's', turnId: null, attempts: 0, loopCount: null, lastTree: null, updatedAt: '', ...p });

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
  it('is claim-gated by default', () => {
    expect(resolveProfile({}, { ...baseInput, lastMessage: DONE }).profile).toBe('full');
    expect(resolveProfile({}, { ...baseInput, lastMessage: QUESTION }).profile).toBe('lite');
    expect(resolveProfile({}, { ...baseInput, lastMessage: null }).profile).toBe('full');
  });
  it('honours config and overrides', () => {
    expect(resolveProfile({ profile: 'lite' }, { ...baseInput, lastMessage: DONE }).profile).toBe('lite');
    expect(resolveProfile({ profile: 'full' }, { ...baseInput, lastMessage: QUESTION }).profile).toBe('full');
    expect(resolveProfile({ profile: 'lite' }, { ...baseInput, lastMessage: QUESTION }, 'full').profile).toBe('full');
    expect(resolveProfile({ claimPatterns: ['ship it'] }, { ...baseInput, lastMessage: 'ship it' }).profile).toBe('full');
  });
});

describe('isContinuation', () => {
  it('uses stop_hook_active for hosts that have it', () => {
    expect(isContinuation({ ...baseInput, stopHookActive: true }, null)).toBe(true);
    expect(isContinuation({ ...baseInput, stopHookActive: false }, state({ attempts: 2 }))).toBe(false);
  });
  it('uses the loop_count delta for Cursor', () => {
    const cursor = { ...baseInput, loopCount: 1 };
    expect(isContinuation(cursor, null)).toBe(false);
    expect(isContinuation(cursor, state({ attempts: 1, loopCount: 0 }))).toBe(true);
    expect(isContinuation(cursor, state({ attempts: 1, loopCount: 1 }))).toBe(false); // new user turn, count unchanged
    expect(isContinuation({ ...baseInput, loopCount: 5 }, state({ attempts: 1, loopCount: 0 }))).toBe(false); // other hooks looped
    expect(isContinuation(cursor, state({ attempts: 0, loopCount: 0 }))).toBe(false); // we did not block last time
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
    expect(readState(repo.root, 'claude', 's1')?.attempts).toBe(1);
    expect(existsSync(join(repo.root, '.isitdone', 'receipt.json'))).toBe(true);
  });

  it('allows when all checks pass and resets attempts', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS, lint: PASS }) } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(o.decision).toBe('allow');
    expect(o.stdout).toBe('');
    expect(o.result?.profile).toBe('full');
    expect(o.result?.ran.map((r) => r.id)).toEqual(['lint', 'test']);
    expect(readState(repo.root, 'claude', 's1')?.attempts).toBe(0);
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

  it('keeps attempts per session so two sessions cannot reset each other', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), '.isitdone.json': '{"maxAttempts": 1}' } });
    expect((await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) })).decision).toBe('block');
    // an unrelated session stops in between
    expect((await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, { session_id: 's2' }) })).decision).toBe('block');
    // session 1 continues: its own counter is intact, so it is released
    const cont = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, { stop_hook_active: true }) });
    expect(cont.decision).toBe('allow');
    expect(cont.why).toMatch(/letting the agent stop/);
    const files = readdirSync(join(repo.root, '.isitdone', 'sessions'));
    expect(files.length).toBe(2);
  });

  it('allows on malformed stdin, nested runs, plan mode, and broken config', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    expect((await runHook({ host: 'claude', stdin: '{"last_assistant_message": "unterminated', cwd: repo.root })).decision).toBe('allow');
    expect((await runHook({ host: 'claude', stdin: '', cwd: repo.root })).decision).toBe('allow');
    const nested = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE), env: { ISITDONE: '1' } });
    expect(nested.why).toMatch(/nested/);
    const plan = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, { permission_mode: 'plan' }) });
    expect(plan.decision).toBe('allow');
    expect(plan.why).toMatch(/plan mode/);
    repo.write('.isitdone.json', '{ not json');
    const broken = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(broken.decision).toBe('allow');
    expect(JSON.parse(broken.stdout).systemMessage).toMatch(/Could not parse/);
  });

  it('treats background tasks as a pause only when there is no completion claim', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL, lint: PASS }) } });
    const tasks = { background_tasks: [{ id: 't', type: 'shell', status: 'running', command: 'npm run dev' }] };
    const pause = await runHook({ host: 'claude', stdin: claudePayload(repo.root, QUESTION, tasks) });
    expect(pause.decision).toBe('allow');
    expect(pause.why).toMatch(/pause/);
    const claimed = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, tasks) });
    expect(claimed.decision).toBe('block');
  });

  it('allows when no checks are detected', async () => {
    repo = tempRepo({ files: { 'README.md': 'x' } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(o.decision).toBe('allow');
    expect(o.result?.ran).toEqual([]);
  });

  it('finds the project root from a subdirectory cwd, and a nested project inside a bigger repo', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), 'sub/dir/file.txt': 'x' } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(join(repo.root, 'sub', 'dir'), DONE) });
    expect(o.decision).toBe('block');
    // a project in a subdirectory of a larger repo (dotfiles-style) is verified at the project, not the git root
    repo.write('apps/web/package.json', nodePkg({ test: PASS }));
    const inner = await runHook({ host: 'claude', stdin: claudePayload(join(repo.root, 'apps', 'web'), DONE) });
    expect(inner.decision).toBe('allow');
    expect(inner.result?.ran.map((r) => `${r.id}:${r.status}`)).toEqual(['test:PASS']);
    expect(existsSync(join(repo.root, 'apps', 'web', '.isitdone', 'receipt.json'))).toBe(true);
  });

  it('tolerates Cursor-shaped input routed through the claude host', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    const stdin = JSON.stringify({ conversation_id: 'c1', hook_event_name: 'stop', workspace_roots: [repo.root], status: 'completed', loop_count: 0 });
    const o = await runHook({ host: 'claude', stdin });
    expect(o.decision).toBe('block');
    expect(o.result?.profile).toBe('full');
  });

  it('doctor mode runs only the injected probe, blocks once, and persists nothing', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE), doctor: true });
    expect(o.decision).toBe('block');
    expect(JSON.parse(o.stdout).reason).toMatch(/simulated failing check/);
    expect(o.result?.ran.map((r) => r.id)).toEqual(['doctor-probe']);
    expect(existsSync(join(repo.root, '.isitdone', 'receipt.json'))).toBe(false);
    expect(existsSync(join(repo.root, '.isitdone', 'sessions'))).toBe(false);
    const again = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE, { stop_hook_active: true }), doctor: true });
    expect(again.decision).toBe('allow');
  });

  it('allows with a warning when session state cannot be written', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    // a regular file where the sessions directory should be
    mkdirSync(join(repo.root, '.isitdone'), { recursive: true });
    writeFileSync(join(repo.root, '.isitdone', 'sessions'), 'not a dir');
    const o = await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    expect(o.decision).toBe('allow');
    expect(JSON.parse(o.stdout).systemMessage).toMatch(/not writable/);
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

  it('cursor: followup_message on block, {} on allow, skips aborted turns, and counts attempts by loop_count delta', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), '.isitdone.json': '{"maxAttempts": 1}' } });
    const p = (loop_count: number, extra: Record<string, unknown> = {}) => JSON.stringify({ ...HOSTS.cursor.synthetic(repo!.root, DONE), loop_count, ...extra });
    const blocked = await runHook({ host: 'cursor', stdin: p(0) });
    expect(JSON.parse(blocked.stdout).followup_message).toMatch(/NOT DONE/);
    const aborted = await runHook({ host: 'cursor', stdin: p(1, { status: 'aborted' }) });
    expect(aborted.stdout).toBe('{}');
    expect(aborted.why).toMatch(/aborted/);
    const looped = await runHook({ host: 'cursor', stdin: p(1) }); // our follow-up: attempts 1 >= max 1
    expect(looped.decision).toBe('allow');
    // a later user turn in the same conversation (loop_count unchanged) is a fresh turn and gets blocked again
    const later = await runHook({ host: 'cursor', stdin: p(1) });
    expect(later.decision).toBe('block');
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

describe('runHook (copilot, qwen, goose, droid, devin, augment, opencode, junie)', () => {
  const failing = (extraFiles: Record<string, string> = {}) => tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), ...extraFiles } });
  const payload = (host: keyof typeof HOSTS, root: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...HOSTS[host].synthetic(root, DONE), ...extra });

  it('copilot: no last message means the full profile; allow/block are decision objects; stop_hook_active counts attempts', async () => {
    repo = failing();
    const blocked = await runHook({ host: 'copilot', stdin: payload('copilot', repo.root) });
    expect(blocked.decision).toBe('block');
    expect(blocked.result?.profile).toBe('full');
    expect(blocked.why).toMatch(/did not provide the final message/);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: 'block' });
    expect(JSON.parse(blocked.stdout).reason).toMatch(/NOT DONE/);
    expect(readState(repo.root, 'copilot', 'isitdone-doctor')?.attempts).toBe(1);
    const cont = await runHook({ host: 'copilot', stdin: payload('copilot', repo.root, { stop_hook_active: true }) });
    expect(JSON.parse(cont.stdout).reason).toMatch(/attempt 2\/3/);
    repo.write('package.json', nodePkg({ test: PASS }));
    const allowed = await runHook({ host: 'copilot', stdin: payload('copilot', repo.root, { stop_hook_active: true }) });
    expect(allowed.decision).toBe('allow');
    expect(JSON.parse(allowed.stdout)).toEqual({ decision: 'allow' });
    expect(allowed.result?.receipt?.host).toBe('copilot-cli');
  });

  it('qwen: claim-gated like Claude Code, {} on allow, block with reason', async () => {
    repo = failing({ 'package.json': nodePkg({ test: FAIL, lint: PASS }) });
    const question = await runHook({ host: 'qwen', stdin: payload('qwen', repo.root, { last_assistant_message: QUESTION }) });
    expect(question.decision).toBe('allow');
    expect(question.stdout).toBe('{}');
    expect(question.result?.ran.map((r) => r.id)).toEqual(['lint']);
    const blocked = await runHook({ host: 'qwen', stdin: payload('qwen', repo.root) });
    expect(blocked.decision).toBe('block');
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: 'block' });
    expect(JSON.parse(blocked.stdout).reason).toMatch(/You claimed/);
    expect(blocked.result?.receipt?.host).toBe('qwen-code');
  });

  it('goose: no cwd in the payload (falls back to the hook cwd); no flag, so attempts count per session and restart after giving up', async () => {
    repo = failing({ '.isitdone.json': '{"maxAttempts": 2}' });
    const stop = () => runHook({ host: 'goose', stdin: JSON.stringify({ event: 'Stop', session_id: 'g1', matcher_context: {}, last_assistant_message: DONE }), cwd: repo!.root });
    const first = await stop();
    expect(first.decision).toBe('block');
    expect(JSON.parse(first.stdout)).toMatchObject({ decision: 'block' });
    expect(JSON.parse(first.stdout).reason).toMatch(/attempt 1\/2/);
    const second = await stop();
    expect(JSON.parse(second.stdout).reason).toMatch(/attempt 2\/2/);
    const third = await stop();
    expect(third.decision).toBe('allow');
    expect(third.why).toMatch(/letting the agent stop/);
    expect(third.stdout).toBe(''); // goose has no channel for a message
    expect(readState(repo.root, 'goose', 'g1')?.attempts).toBe(0);
    // the turn ended with that allow; the next stop is a fresh turn
    const fresh = await stop();
    expect(JSON.parse(fresh.stdout).reason).toMatch(/attempt 1\/2/);
    // a pass resets the counter too
    repo.write('package.json', nodePkg({ test: PASS }));
    expect((await stop()).decision).toBe('allow');
    expect(readState(repo.root, 'goose', 'g1')?.attempts).toBe(0);
  });

  it('droid: Claude envelope, full profile, systemMessage on a give-up', async () => {
    repo = failing({ '.isitdone.json': '{"maxAttempts": 1}' });
    const blocked = await runHook({ host: 'droid', stdin: payload('droid', repo.root) });
    expect(blocked.result?.profile).toBe('full');
    expect(Object.keys(JSON.parse(blocked.stdout)).sort()).toEqual(['decision', 'reason']);
    const gaveUp = await runHook({ host: 'droid', stdin: payload('droid', repo.root, { stop_hook_active: true }) });
    expect(gaveUp.decision).toBe('allow');
    expect(JSON.parse(gaveUp.stdout).systemMessage).toMatch(/still failing after 1 attempt/);
  });

  it('devin: payload without cwd, DEVIN_PROJECT_DIR points at the repo', async () => {
    repo = failing();
    process.env.DEVIN_PROJECT_DIR = repo.root;
    try {
      const blocked = await runHook({ host: 'devin', stdin: payload('devin', repo.root) });
      expect(blocked.decision).toBe('block');
      expect(blocked.result?.profile).toBe('full');
      expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: 'block' });
      expect(readState(repo.root, 'devin', 'isitdone-doctor')?.attempts).toBe(1);
      // the same registration under Claude's adapter also finds the repo through the env
      const viaClaude = await runHook({ host: 'claude', stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'v', prompt_id: 'p', stop_hook_active: false }) });
      expect(viaClaude.decision).toBe('block');
    } finally {
      delete process.env.DEVIN_PROJECT_DIR;
    }
  });

  it('augment: nested block, empty allow, skips interrupted turns, counts attempts without a flag', async () => {
    repo = failing({ '.isitdone.json': '{"maxAttempts": 1}' });
    const blocked = await runHook({ host: 'augment', stdin: payload('augment', repo.root) });
    expect(blocked.decision).toBe('block');
    expect(JSON.parse(blocked.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'Stop', decision: 'block' });
    expect(JSON.parse(blocked.stdout).hookSpecificOutput.reason).toMatch(/You claimed/);
    const interrupted = await runHook({ host: 'augment', stdin: payload('augment', repo.root, { agent_stop_cause: 'interrupted' }) });
    expect(interrupted.decision).toBe('allow');
    expect(interrupted.why).toMatch(/interrupted/);
    const gaveUp = await runHook({ host: 'augment', stdin: payload('augment', repo.root) });
    expect(gaveUp.decision).toBe('allow');
    expect(JSON.parse(gaveUp.stdout).systemMessage).toMatch(/still failing/);
    // without the conversation data the profile falls back to full
    const noText = await runHook({ host: 'augment', stdin: JSON.stringify({ hook_event_name: 'Stop', conversation_id: 'c2', workspace_roots: [repo.root], agent_stop_cause: 'end_turn' }) });
    expect(noText.result?.profile).toBe('full');
  });

  it('opencode: the shim payload blocks with a reason for the follow-up and honours the shim-derived flag', async () => {
    repo = failing({ '.isitdone.json': '{"maxAttempts": 2}' });
    const blocked = await runHook({ host: 'opencode', stdin: payload('opencode', repo.root) });
    expect(blocked.decision).toBe('block');
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: 'block' });
    expect(JSON.parse(blocked.stdout).reason).toMatch(/attempt 1\/2/);
    const second = await runHook({ host: 'opencode', stdin: payload('opencode', repo.root, { stop_hook_active: true, loop_count: 1 }) });
    expect(JSON.parse(second.stdout).reason).toMatch(/attempt 2\/2/);
    const third = await runHook({ host: 'opencode', stdin: payload('opencode', repo.root, { stop_hook_active: true, loop_count: 2 }) });
    expect(third.decision).toBe('allow');
    expect(third.stdout).toBe('');
  });

  it('junie: no session id or cwd; state is per repository; stop_hook_active drives the cap', async () => {
    repo = failing({ '.isitdone.json': '{"maxAttempts": 1}' });
    const blocked = await runHook({ host: 'junie', stdin: payload('junie', repo.root), cwd: repo.root });
    expect(blocked.decision).toBe('block');
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: 'block' });
    expect(blocked.result?.receipt?.host).toBe('junie-cli');
    expect(readState(repo.root, 'junie', null)?.attempts).toBe(1);
    const gaveUp = await runHook({ host: 'junie', stdin: payload('junie', repo.root, { stop_hook_active: true }), cwd: repo.root });
    expect(gaveUp.decision).toBe('allow');
    expect(gaveUp.stdout).toBe('');
  });

  it('doctor mode blocks once for every host with its own synthetic payload (what `isitdone doctor` runs)', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    for (const name of Object.keys(HOSTS) as Array<keyof typeof HOSTS>) {
      const host = HOSTS[name];
      const o = await runHook({ host: name, stdin: JSON.stringify(host.synthetic(repo.root, DONE)), doctor: true, cwd: repo.root });
      expect(o.decision, name).toBe('block');
      expect(o.result?.ran.map((r) => r.id), name).toEqual(['doctor-probe']);
    }
    expect(existsSync(join(repo.root, '.isitdone', 'sessions'))).toBe(false);
  });
});

describe('state files', () => {
  it('live under .isitdone/sessions, keyed by host and session, and are ignored by git', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    await runHook({ host: 'claude', stdin: claudePayload(repo.root, DONE) });
    const dir = join(repo.root, '.isitdone', 'sessions');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^claude-[0-9a-f]{16}\.json$/);
    const st = JSON.parse(readFileSync(join(dir, files[0] as string), 'utf8')) as SessionState;
    expect(st.sessionId).toBe('s1');
    expect(st.host).toBe('claude');
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});
