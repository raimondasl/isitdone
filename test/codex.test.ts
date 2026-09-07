import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexSessionFiles, commandOutcome, exitOk, scanCodexSession } from '../src/codex.js';
import { scanHistory } from '../src/history.js';
import type { ClaimRecord } from '../src/turns.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  dir = null;
});

type Rec = Record<string, unknown>;
let t = Date.parse('2026-09-01T10:00:00Z');
const tick = () => new Date((t += 60_000)).toISOString();
const line = (type: string, payload: Rec): Rec => ({ timestamp: tick(), type, payload });
const meta = (cwd: string): Rec => ({ timestamp: tick(), type: 'session_meta', payload: { id: 'thread-1', timestamp: '2026-09-01T10:00:00Z', cwd, originator: 'codex_cli_rs', cli_version: '0.153.4', source: 'cli' } });
const user = (text: string): Rec => line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text: string): Rec => line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const exec = (id: string, cmd: string): Rec => line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: id });
const output = (id: string, code: number): Rec => line('response_item', { type: 'function_call_output', call_id: id, output: `Wall time: 1.0 seconds\nProcess exited with code ${code}\nOutput:\n...` });
let pn = 0;
const patch = (): Rec => line('response_item', { type: 'custom_tool_call', status: 'completed', call_id: `p${++pn}`, name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n' });

function write(rel: string, records: Rec[]): string {
  const p = join(dir as string, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

describe('scanCodexSession', () => {
  it('legacy layout: user messages bound turns; exec_command outputs carry the exit code', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-codex-'));
    const file = write('sessions/2026/09/01/rollout-2026-09-01T10-00-00-thread-1.jsonl', [
      meta('/work/app'),
      user('<environment_context>\nignored injected context</environment_context>'),
      user('add the feature'),
      patch(),
      exec('c1', 'npm test'),
      output('c1', 0),
      assistant('Done. All tests pass.'),
      user('## My request for Codex:\nfix the bug'),
      patch(),
      exec('c2', 'pytest -q'),
      output('c2', 1),
      assistant('Fixed the bug and verified it.'),
      user('and one more'),
      patch(),
      exec('c3', 'npx tsc --noEmit'),
      output('c3', 0),
      assistant('Implemented the change; typecheck passes.'),
    ]);
    const out: ClaimRecord[] = [];
    const stats = { editTurns: 0 };
    await scanCodexSession(file, {}, out, stats);
    expect(stats.editTurns).toBe(3);
    expect(out.map((c) => [c.verdict, c.agent, c.project])).toEqual([
      ['VERIFIED', 'codex', '/work/app'],
      ['FAILED', 'codex', '/work/app'],
      ['NEVER_RAN', 'codex', '/work/app'],
    ]);
    expect(out[2]?.checkRuns).toBe(1);
  });

  it('paginated layout: turn events bound turns, CommandExecution items carry exit codes, last_agent_message is the claim', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-codex-'));
    const item = (item: Rec): Rec => line('event_msg', { type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn', item });
    const file = write('sessions/2026/09/02/rollout-2026-09-02T10-00-00-thread-2.jsonl', [
      meta('/work/app2'),
      line('event_msg', { type: 'turn_started', turn_id: 't1' }),
      item({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'go' }] }),
      item({ type: 'FileChange', id: 'f1', changes: { '/work/app2/src/a.ts': { type: 'update', unified_diff: '@@', move_path: null } }, status: 'completed' }),
      item({ type: 'CommandExecution', id: 'c1', command: ['bash', '-lc', 'npm test'], cwd: '/work/app2', status: 'completed', exit_code: 0 }),
      item({ type: 'FileChange', id: 'f2', changes: { '/work/app2/src/b.ts': { type: 'update', unified_diff: '@@', move_path: null } }, status: 'completed' }),
      line('event_msg', { type: 'turn_complete', turn_id: 't1', last_agent_message: 'Done, tests pass.' }),
      line('event_msg', { type: 'turn_started', turn_id: 't2' }),
      item({ type: 'FileChange', id: 'f3', changes: {}, status: 'completed' }),
      item({ type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'All set.' }] }),
      line('event_msg', { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' }),
    ]);
    const out: ClaimRecord[] = [];
    await scanCodexSession(file, {}, out, { editTurns: 0 });
    expect(out.map((c) => [c.verdict, c.claim])).toEqual([
      ['STALE', 'Done, tests pass.'],
      ['NEVER_RAN', 'All set.'],
    ]);
  });

  it('exitOk understands the modern header, legacy JSON metadata, and unknown output', () => {
    expect(exitOk('Wall time: 2.3 seconds\nProcess exited with code 0\nOutput:\nok')).toBe(true);
    expect(exitOk('Process exited with code 2\nOutput:\nFAIL')).toBe(false);
    expect(exitOk('{"output":"x","metadata":{"exit_code":1,"duration_seconds":0.1}}')).toBe(false);
    expect(exitOk('{"output":"x","metadata":{"exit_code":0,"duration_seconds":0.1}}')).toBe(true);
    expect(exitOk('Process running with session ID 5\nOutput:\n...')).toBeNull();
    expect(commandOutcome('Wall time: 10.0 seconds\nProcess running with session ID 5\nOutput:\n...').running).toBe('5');
    expect(exitOk(undefined)).toBeNull();
    // freeform shell header
    expect(exitOk('Exit code: 1\nWall time: 4.2 seconds\nOutput:\nFAIL src/a.test.ts')).toBe(false);
    expect(exitOk('Exit code: 0\nWall time: 1.0 seconds\nOutput:\nok')).toBe(true);
    expect(exitOk('command timed out after 5000 milliseconds\nExit code: 124\nWall time: 5.0 seconds\nOutput:\n')).toBe(false);
    expect(commandOutcome('exec command rejected: user declined').rejected).toBe(true);
  });

  it('legacy layout: freeform shell exits, commands that outlive the yield window, declined commands, turn_aborted', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-codex-'));
    const shell = (id: string, cmd: string): Rec => line('response_item', { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: cmd }), call_id: id });
    const stdin = (id: string, sid: number): Rec => line('response_item', { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ session_id: sid, chars: '' }), call_id: id });
    const raw = (id: string, output: string): Rec => line('response_item', { type: 'function_call_output', call_id: id, output });
    const file = write('sessions/2026/09/03/rollout-2026-09-03T10-00-00-thread-3.jsonl', [
      meta('/work/app3'),
      // 1: freeform shell header carries the failure
      user('fix it'),
      patch(),
      shell('s1', 'npm test'),
      raw('s1', 'Exit code: 1\nWall time: 4.2 seconds\nOutput:\nFAIL src/a.test.ts'),
      assistant('Fixed; tests pass.'),
      // 2: the test run outlives the yield window; the exit arrives with a write_stdin poll
      user('again'),
      patch(),
      exec('c2', 'npm test'),
      raw('c2', 'Wall time: 10.0 seconds\nProcess running with session ID 3\nOutput:\n...'),
      stdin('w1', 3),
      raw('w1', 'Wall time: 10.0 seconds\nProcess running with session ID 3\nOutput:\n...'),
      stdin('w2', 3),
      raw('w2', 'Wall time: 5.0 seconds\nProcess exited with code 1\nOutput:\n Tests 3 failed'),
      assistant('Implemented the change and tests pass.'),
      // 3: the user declined the test command
      user('once more'),
      patch(),
      exec('c3', 'npm test'),
      raw('c3', 'exec command rejected: user declined'),
      assistant('Done, tests pass.'),
      // 4: an aborted turn (older builds persisted turn_aborted alone); later turns must still be split by user messages
      user('and'),
      patch(),
      line('event_msg', { type: 'turn_aborted', turn_id: 't4', reason: 'interrupted' }),
      user('finally'),
      patch(),
      exec('c5', 'npm test'),
      output('c5', 0),
      assistant('All done, tests pass.'),
    ]);
    const out: ClaimRecord[] = [];
    await scanCodexSession(file, {}, out, { editTurns: 0 });
    expect(out.map((c) => [c.verdict, c.testRuns])).toEqual([
      ['FAILED', 1],
      ['FAILED', 1],
      ['NEVER_RAN', 0],
      ['VERIFIED', 1],
    ]);
  });

  it('paginated layout with response_item copies: every edit and command is counted once, items settle running commands', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-codex-'));
    const item = (item: Rec): Rec => line('event_msg', { type: 'item_completed', thread_id: 'thread-4', turn_id: 'turn', item });
    const raw = (id: string, output: string): Rec => line('response_item', { type: 'function_call_output', call_id: id, output });
    const file = write('sessions/2026/09/04/rollout-2026-09-04T10-00-00-thread-4.jsonl', [
      meta('/work/app4'),
      line('event_msg', { type: 'turn_started', turn_id: 't1' }),
      line('response_item', { type: 'custom_tool_call', status: 'completed', call_id: 'f1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch\n' }),
      item({ type: 'FileChange', id: 'f1', changes: {}, status: 'completed' }),
      exec('c1', 'npm test'),
      raw('c1', 'Wall time: 10.0 seconds\nProcess running with session ID 9\nOutput:\n...'),
      item({ type: 'CommandExecution', id: 'c1', command: ['bash', '-lc', 'npm test'], status: 'failed', exit_code: 1 }),
      line('event_msg', { type: 'turn_complete', turn_id: 't1', last_agent_message: 'Done, tests pass.' }),
      line('event_msg', { type: 'turn_started', turn_id: 't2' }),
      item({ type: 'FileChange', id: 'f2', changes: {}, status: 'completed' }),
      item({ type: 'CommandExecution', id: 'c2', command: ['bash', '-lc', 'npm test'], status: 'declined' }),
      line('event_msg', { type: 'turn_complete', turn_id: 't2', last_agent_message: 'Done, tests pass.' }),
    ]);
    const out: ClaimRecord[] = [];
    await scanCodexSession(file, {}, out, { editTurns: 0 });
    expect(out.map((c) => [c.verdict, c.edits, c.testRuns])).toEqual([
      ['FAILED', 1, 1],
      ['NEVER_RAN', 1, 0],
    ]);
  });

  it('finds rollouts in nested and flat layouts plus archived sessions, and history merges them with Claude Code', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-codex-'));
    const codexHome = join(dir, 'codex');
    write('codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-a.jsonl', [meta('/w/a'), user('x'), patch(), exec('c', 'npm test'), output('c', 0), assistant('Done.')]);
    write('codex/sessions/rollout-2025-05-07T17-24-21-old.jsonl', [meta('/w/old'), user('x'), patch(), assistant('Done.')]);
    write('codex/archived_sessions/rollout-2026-01-01T00-00-00-z.jsonl', [meta('/w/z'), user('x'), assistant('nothing edited, done.')]);
    write('codex/sessions/2026/09/01/not-a-rollout.txt', []);
    const found = codexSessionFiles(codexHome, null);
    expect(found.files.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual(['rollout-2025-05-07T17-24-21-old.jsonl', 'rollout-2026-01-01T00-00-00-z.jsonl', 'rollout-2026-09-01T10-00-00-a.jsonl']);
    const projects = join(dir, 'projects');
    mkdirSync(projects, { recursive: true });
    const r = await scanHistory({ projectsDir: projects, codexDir: codexHome });
    expect(r.sessions).toBe(3);
    expect(r.claims.map((c) => [c.project, c.verdict])).toEqual([
      ['/w/a', 'VERIFIED'],
      ['/w/old', 'NEVER_RAN'],
    ]);
    expect(r.byAgent.codex).toEqual({ sessions: 3, claims: 2, verified: 1 });
    const none = await scanHistory({ projectsDir: projects, codexDir: null });
    expect(none.sessions).toBe(0);
  });
});
