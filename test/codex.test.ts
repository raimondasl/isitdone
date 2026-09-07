import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexSessionFiles, exitOk, scanCodexSession } from '../src/codex.js';
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
const patch = (): Rec => line('response_item', { type: 'custom_tool_call', status: 'completed', call_id: 'p', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n' });

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
    expect(exitOk(undefined)).toBeNull();
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
