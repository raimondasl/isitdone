/**
 * Gemini CLI and Qwen Code transcript fixtures. Every shape here is RECONSTRUCTED from the vendors' source
 * (gemini-cli chatRecordingService.ts / shell.ts / projectRegistry.ts, qwen-code chatRecordingService.ts / shell.ts,
 * main as of 2026-09-07), not copied from observed session files: no Gemini or Qwen install was available.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { geminiProjectLabel, geminiSessionFiles, geminiShellOutcome, loadGeminiMessages, qwenSessionFiles, scanGeminiSession, scanQwenSession } from '../src/gemini.js';
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
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const jsonl = (records: Rec[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

function write(rel: string, content: string): string {
  const p = join(dir as string, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// --- Gemini CLI records (chatRecordingTypes.ts: MessageRecord, ToolCallRecord) ---
const gMeta = (extra: Rec = {}): Rec => ({ sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', projectHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', startTime: tick(), lastUpdated: tick(), kind: 'main', ...extra });
const gUser = (text: string): Rec => ({ id: uid(), timestamp: tick(), type: 'user', content: [{ text }] });
const gModel = (text: string, toolCalls?: Rec[]): Rec => ({ id: uid(), timestamp: tick(), type: 'gemini', content: text, model: 'gemini-2.5-pro', ...(toolCalls ? { toolCalls } : {}) });
const fr = (id: string, name: string, output: string): Rec[] => [{ functionResponse: { id, name, response: { output } } }];
const gEdit = (status = 'success'): Rec => {
  const id = `replace-${t}-${uid().slice(-4)}`;
  return { id, name: 'replace', args: { file_path: '/work/app/src/foo.ts', old_string: 'a', new_string: 'b' }, result: fr(id, 'replace', 'Successfully modified file: /work/app/src/foo.ts (1 replacements).'), status, timestamp: tick(), displayName: 'Edit' };
};
const gShell = (command: string, output: string, status = 'success', resultDisplay?: string): Rec => {
  const id = `run_shell_command-${t}-${uid().slice(-4)}`;
  return { id, name: 'run_shell_command', args: { command, description: 'run' }, result: fr(id, 'run_shell_command', output), status, timestamp: tick(), displayName: 'Shell', ...(resultDisplay !== undefined ? { resultDisplay } : {}) };
};
/** Current builds: "Exit Code:" only for non-zero exits. */
const modernOut = (body: string, code: number) => `Output: ${body}${code !== 0 ? `\nExit Code: ${code}` : ''}\nProcess Group PGID: 4242`;
/** Qwen and pre-2026 Gemini builds: the exit code is always printed. */
const legacyOut = (cmd: string, body: string, code: number | null, signal = '(none)') => `Command: ${cmd}\nDirectory: (root)\nOutput: ${body}\nError: (none)\nExit Code: ${code ?? '(none)'}\nSignal: ${signal}\nProcess Group PGID: 4242`;

async function scanGemini(file: string, label = '/work/app', includeSubagents = false): Promise<{ out: ClaimRecord[]; editTurns: number }> {
  const out: ClaimRecord[] = [];
  const stats = { editTurns: 0 };
  await scanGeminiSession(file, { includeSubagents }, label, out, stats);
  return { out, editTurns: stats.editTurns };
}

describe('Gemini CLI sessions', () => {
  it('JSONL (v0.39+): a re-appended message replaces the earlier one, $set patches and rewinds apply, exit code only when non-zero', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-gemini-'));
    const m1 = gModel('I will change the assertion and run the tests.');
    const m2 = gModel('Running the suite again.');
    const first: Rec[] = [
      gMeta(),
      gUser('fix the failing test'),
      m1,
      { $set: { lastUpdated: tick() } },
      // tool calls are attached by re-appending the whole model message under the same id
      { ...m1, toolCalls: [gEdit(), gShell('npm test', modernOut('FAIL src/foo.test.ts', 1), 'success', 'Command exited with code: 1')] },
      gModel('Done - the test now passes.'),
      gUser('again please'),
      m2,
      { ...m2, toolCalls: [gEdit(), gShell('npm test', modernOut('3 passed', 0))] },
      gModel('All tests pass.'),
    ];
    const third = gUser('one more');
    const m3 = gModel('Editing.');
    const records: Rec[] = [
      ...first,
      // updateMessagesFromHistory() rewrites every message; the rewrite keeps the tool calls
      { $set: { messages: [gUser('fix the failing test'), { ...first[4] as Rec }, first[5] as Rec, gUser('again please'), first[8] as Rec, first[9] as Rec], lastUpdated: tick() } },
      third,
      { ...m3, toolCalls: [gEdit()] },
      gModel('Done.'),
      { $rewindTo: third.id as string },
    ];
    const file = write('tmp/app/chats/session-2026-09-01T10-00-a1b2c3d4.jsonl', jsonl(records));
    const loaded = await loadGeminiMessages(file);
    expect(loaded.messages.map((m) => m.type)).toEqual(['user', 'gemini', 'gemini', 'user', 'gemini', 'gemini']);
    expect(loaded.meta.kind).toBe('main');
    const { out, editTurns } = await scanGemini(file);
    expect(editTurns).toBe(2);
    expect(out.map((c) => [c.verdict, c.agent, c.project, c.claim])).toEqual([
      ['FAILED', 'gemini', '/work/app', 'Done - the test now passes.'],
      ['VERIFIED', 'gemini', '/work/app', 'All tests pass.'],
    ]);
    expect(out[0]?.session).toBe('session-2026-09-01T10-00-a1b2c3d4');
  });

  it('legacy .json (v0.2-v0.38): whole-file record, old shell block, notices ignored; cancelled, backgrounded and signalled commands', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-gemini-'));
    const record = {
      ...gMeta({ kind: undefined }),
      messages: [
        gUser('fix'),
        gModel('On it.', [gEdit(), gShell('pytest -q', legacyOut('pytest -q', '3 passed', 0))]),
        { id: uid(), timestamp: tick(), type: 'info', content: 'Model switched.' },
        gModel('Done, tests pass.'),
        gUser('next'),
        gModel('Editing.', [gEdit(), gShell('npm test', 'Command was cancelled by user before it could complete. There was no output before it was cancelled.', 'cancelled')]),
        gModel('Done.'),
        gUser('next'),
        gModel('Editing.', [gEdit(), gShell('npm test', 'Command moved to background (PID: 5). Output hidden. Press Ctrl+B to view.')]),
        gModel('All done.'),
        gUser('next'),
        gModel('Editing.', [gEdit(), gShell('npm test', legacyOut('npm test', '(empty)', null, 'SIGKILL'))]),
        gModel('Finished; tests pass.'),
        gUser('next'),
        gModel('Editing.', [gEdit('error'), gShell('npm test', legacyOut('npm test', 'ok', 0))]),
        gModel('Done.'),
      ],
    };
    const file = write('tmp/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08/chats/session-2026-01-10T09-30-abcdef12.json', JSON.stringify(record, null, 2));
    const { out, editTurns } = await scanGemini(file, 'gemini:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    // the last turn's only edit failed, so it is not an edit turn and makes no claim
    expect(editTurns).toBe(4);
    expect(out.map((c) => [c.verdict, c.testRuns])).toEqual([
      ['VERIFIED', 1],
      ['NEVER_RAN', 0],
      ['NEVER_RAN', 0],
      ['FAILED', 1],
    ]);
  });

  it('geminiShellOutcome reads both output layouts, the display string, and non-completions', () => {
    expect(geminiShellOutcome(modernOut('ok', 0), 'success')).toEqual({ ran: true, ok: true });
    expect(geminiShellOutcome(modernOut('FAIL', 2), 'success')).toEqual({ ran: true, ok: false });
    expect(geminiShellOutcome(legacyOut('x', 'ok', 0), 'success')).toEqual({ ran: true, ok: true });
    expect(geminiShellOutcome(legacyOut('x', 'bad', 1), 'success')).toEqual({ ran: true, ok: false });
    expect(geminiShellOutcome('Output: ...', 'error')).toEqual({ ran: true, ok: false });
    expect(geminiShellOutcome('Output: ...', undefined, 'Command exited with code: 3')).toEqual({ ran: true, ok: false });
    expect(geminiShellOutcome('Output: ...', undefined)).toEqual({ ran: true, ok: null });
    expect(geminiShellOutcome('Command was automatically cancelled because it exceeded the timeout of 5.0 minutes without output. There was no output before it was cancelled.', 'success').ran).toBe(false);
    expect(geminiShellOutcome('Output: x', 'cancelled').ran).toBe(false);
    // an "Exit Code:" line inside the command's own output does not count: only a line-start match does
    expect(geminiShellOutcome('Output: the script printed Exit Code: 1 mid-line\nProcess Group PGID: 1', 'success')).toEqual({ ran: true, ok: true });
  });

  it('labels projects from .project_root, projects.json or the bare id; nested subagent sessions only with --include-subagents; since skips old files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-gemini-'));
    const gemini = join(dir, 'gemini');
    const session = () => jsonl([gMeta(), gUser('go'), gModel('Editing.', [gEdit(), gShell('npm test', modernOut('ok', 0))]), gModel('Done, tests pass.')]);
    write('gemini/tmp/app/chats/session-2026-09-01T10-00-11111111.jsonl', session());
    write('gemini/tmp/app/.project_root', '/work/app\n');
    write('gemini/tmp/lib/chats/session-2026-09-01T10-00-22222222.jsonl', session());
    write('gemini/projects.json', JSON.stringify({ projects: { '/work/lib': 'lib', '/work/app': 'app' } }));
    write('gemini/tmp/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08/chats/session-2026-01-10T09-30-33333333.json', JSON.stringify({ ...gMeta({ kind: undefined }), messages: [gUser('go'), gModel('Editing.', [gEdit()]), gModel('Done.')] }));
    write('gemini/tmp/app/chats/a1b2c3d4-e5f6-7890-abcd-ef1234567890/session-2026-09-01T10-05-44444444.jsonl', jsonl([gMeta({ kind: 'subagent', directories: ['/work/app'] }), gUser('sub'), gModel('Editing.', [gEdit()]), gModel('Done.')]));
    write('gemini/tmp/app/checkpoint-mytag.json', '{"history":[]}');
    write('gemini/tmp/app/chats/not-a-session.txt', 'x');
    expect(geminiProjectLabel(gemini, 'app')).toBe('/work/app');
    expect(geminiProjectLabel(gemini, 'lib')).toBe('/work/lib');
    expect(geminiProjectLabel(gemini, 'nope')).toBe('gemini:nope');
    const found = geminiSessionFiles(gemini, null);
    expect(found.files.map((f) => [f.slug, f.label]).sort()).toEqual([
      ['9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'gemini:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
      ['app', '/work/app'],
      ['lib', '/work/lib'],
    ]);
    expect(geminiSessionFiles(gemini, null, true).files).toHaveLength(4);
    expect(geminiSessionFiles(gemini, new Date('2030-01-01')).skipped).toBe(3);
    const none = { projectsDir: join(dir, 'nope'), codexDir: null, qwenDir: null, cursorDir: null, cursorUserDir: null };
    const r = await scanHistory({ ...none, geminiDir: gemini });
    expect(r.sessions).toBe(3);
    expect(r.byAgent.gemini).toEqual({ sessions: 3, claims: 3, verified: 2 });
    expect(r.claims.map((c) => c.project).sort()).toEqual(['/work/app', '/work/lib', 'gemini:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08']);
    const sub = await scanHistory({ ...none, geminiDir: gemini, includeSubagents: true });
    expect(sub.sessions).toBe(4);
    // the subagent file scanned without the flag (it declares kind: subagent) makes no claims
    const out: ClaimRecord[] = [];
    await scanGeminiSession(join(gemini, 'tmp/app/chats/a1b2c3d4-e5f6-7890-abcd-ef1234567890/session-2026-09-01T10-05-44444444.jsonl'), {}, '/work/app', out, { editTurns: 0 });
    expect(out).toEqual([]);
  });
});

// --- Qwen Code records (chatRecordingService.ts ChatRecord) ---
const cwd = 'C:\\Users\\me\\app';
let parent: string | null = null;
const qRec = (type: string, extra: Rec): Rec => {
  const uuid = uid();
  const r: Rec = { uuid, parentUuid: parent, sessionId: '0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5', timestamp: tick(), type, cwd, version: '0.23.0', gitBranch: 'main', ...extra };
  parent = uuid;
  return r;
};
const qUser = (text: string, extra: Rec = {}): Rec => qRec('user', { provenance: 'real_user', message: { role: 'user', parts: [{ text }] }, ...extra });
const qAssistant = (parts: Rec[], extra: Rec = {}): Rec => qRec('assistant', { provenance: 'assistant_output', model: 'qwen3-coder-plus', message: { role: 'model', parts }, ...extra });
const qCall = (id: string, name: string, args: Rec): Rec => ({ functionCall: { id, name, args } });
const qResult = (id: string, name: string, output: string, status = 'success', extra: Rec = {}): Rec => qRec('tool_result', { provenance: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id, name, response: { output } } }] }, toolCallResult: { callId: id, status, ...extra } });
const qEditCall = (id: string) => qCall(id, 'edit', { file_path: `${cwd}\\src\\foo.ts`, old_string: 'a', new_string: 'b' });
const qEditResult = (id: string) => qResult(id, 'edit', `Successfully modified file: ${cwd}\\src\\foo.ts (1 replacements).`, 'success', { resultDisplay: { fileDiff: '...', fileName: 'foo.ts' } });
const qShellCall = (id: string, command: string) => qCall(id, 'run_shell_command', { command, description: 'run' });
const qTurnResult = (resultText: string, state = 'completed') => qRec('system', { subtype: 'turn_result', provenance: 'system', systemPayload: { promptId: 'p-1', state, stopReason: 'STOP', startedAt: t - 1000, endedAt: t, resultText } });

describe('Qwen Code sessions', () => {
  it('JSONL: the exit code is always printed, cwd is the project, mid-turn user messages and sidechains do not start turns', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-qwen-'));
    const records: Rec[] = [
      qUser('fix the failing test'),
      qAssistant([{ text: 'Editing the assertion.' }, qEditCall('call_1')]),
      qEditResult('call_1'),
      qAssistant([qShellCall('call_2', 'npm test')]),
      qResult('call_2', 'run_shell_command', legacyOut('npm test', '1 failed', 1), 'success', { resultDisplay: 'Command exited with code: 1' }),
      qAssistant([{ thought: true, text: 'hidden reasoning' }, { text: 'All tests pass now.' }]),
      qTurnResult('All tests pass now.'),
      // turn 2: a message typed while tools were running does not split the turn
      qUser('and the other one'),
      qAssistant([qEditCall('call_3')]),
      qEditResult('call_3'),
      qAssistant([qShellCall('call_4', 'npx vitest run')]),
      qUser('also check lint', { subtype: 'mid_turn_user_message', systemPayload: { displayText: 'also check lint' } }),
      qResult('call_4', 'run_shell_command', legacyOut('npx vitest run', '5 passed', 0)),
      qAssistant([{ text: 'Done.' }]),
      // turn 3: a subagent round (sidechain) claims success, the main turn never ran tests; the shell call was cancelled
      qUser('third'),
      qAssistant([qEditCall('call_5')], { isSidechain: true, agentId: 'agent-1' }),
      qEditResult('call_5'),
      qAssistant([{ text: 'Subagent: all tests pass.' }], { isSidechain: true, agentId: 'agent-1' }),
      qAssistant([qEditCall('call_6')]),
      qEditResult('call_6'),
      qAssistant([qShellCall('call_7', 'npm test')]),
      qResult('call_7', 'run_shell_command', 'Command was cancelled by user before it could complete. There was no output before it was cancelled.', 'cancelled'),
      qAssistant([{ text: 'Done.' }]),
      // turn 4: the edit itself failed: no edit turn, no claim
      qUser('fourth'),
      qAssistant([qEditCall('call_8')]),
      qResult('call_8', 'edit', 'Error: old_string not found', 'error', { error: { message: 'not found' } }),
      qAssistant([{ text: 'Done.' }]),
    ];
    const file = write('qwen/projects/c--users-me-app/chats/0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.jsonl', jsonl(records));
    const out: ClaimRecord[] = [];
    const stats = { editTurns: 0 };
    let seen: string | null = null;
    await scanQwenSession(file, {}, { label: 'qwen:c--users-me-app', sawCwd: (c) => (seen = c) }, out, stats);
    expect(seen).toBe(cwd);
    expect(stats.editTurns).toBe(3);
    expect(out.map((c) => [c.verdict, c.agent, c.project, c.claim, c.testRuns])).toEqual([
      ['FAILED', 'qwen', cwd, 'All tests pass now.', 1],
      ['VERIFIED', 'qwen', cwd, 'Done.', 1],
      ['NEVER_RAN', 'qwen', cwd, 'Done.', 0],
    ]);
  });

  it('a /rewind leaves the truncated branch in the file; only the live parentUuid chain is graded', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-qwen-'));
    const one = [qUser('one'), qAssistant([qEditCall('e1')]), qEditResult('e1'), qAssistant([{ text: 'Done.' }])];
    const two = [qUser('two'), qAssistant([qEditCall('e2')]), qEditResult('e2'), qAssistant([{ text: 'Implemented, done.' }])];
    // rewind to before turn two: the next record is parented to the last record of turn one
    parent = one[3]?.uuid as string;
    const rewind = qRec('system', { subtype: 'rewind', provenance: 'system', systemPayload: { truncatedCount: two.length } });
    const three = [qUser('three'), qAssistant([qEditCall('e3')]), qEditResult('e3'), qAssistant([qShellCall('s3', 'npm test')]), qResult('s3', 'run_shell_command', legacyOut('npm test', 'ok', 0)), qAssistant([{ text: 'Done, tests pass.' }])];
    const file = write('qwen/projects/c--users-me-app/chats/0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.jsonl', jsonl([...one, ...two, rewind, ...three]));
    const out: ClaimRecord[] = [];
    const stats = { editTurns: 0 };
    await scanQwenSession(file, {}, { label: 'qwen:c--users-me-app', sawCwd: () => {} }, out, stats);
    expect(out.map((c) => [c.verdict, c.claim])).toEqual([
      ['NEVER_RAN', 'Done.'],
      ['VERIFIED', 'Done, tests pass.'],
    ]);
    expect(stats.editTurns).toBe(2);
  });

  it('finds session files (not sidecars) and history merges Gemini and Qwen with exclusions and since', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-qwen-'));
    const qwen = join(dir, 'qwen');
    const gemini = join(dir, 'gemini');
    const qSession = () => jsonl([qUser('go'), qAssistant([qEditCall('c1')]), qEditResult('c1'), qAssistant([qShellCall('c2', 'npm test')]), qResult('c2', 'run_shell_command', legacyOut('npm test', 'ok', 0)), qAssistant([{ text: 'Done, tests pass.' }])]);
    write('qwen/projects/c--users-me-app/chats/0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.jsonl', qSession());
    write('qwen/projects/c--users-me-app/chats/0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.ledger.jsonl', '{"x":1}\n');
    write('qwen/projects/c--users-me-app/chats/0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.worktree.json', '{}');
    write('qwen/projects/-home-me-secret-thing/chats/1c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.jsonl', qSession());
    write('gemini/tmp/app/chats/session-2026-09-01T10-00-11111111.jsonl', jsonl([gMeta(), gUser('go'), gModel('Editing.', [gEdit(), gShell('npm test', modernOut('ok', 0))]), gModel('Done, tests pass.')]));
    write('gemini/tmp/app/.project_root', '/work/app');
    write('gemini/tmp/ops/chats/session-2026-09-01T10-00-22222222.jsonl', jsonl([gMeta(), gUser('go'), gModel('Editing.', [gEdit()]), gModel('Done.')]));
    write('gemini/tmp/ops/.project_root', '/work/secret-ops');
    expect(qwenSessionFiles(qwen, null).files.map((f) => f.slug).sort()).toEqual(['-home-me-secret-thing', 'c--users-me-app']);
    const base = { projectsDir: join(dir, 'nope'), codexDir: null, cursorDir: null, cursorUserDir: null, geminiDir: gemini, qwenDir: qwen };
    const r = await scanHistory({ ...base, exclude: ['secret'] });
    expect(r.excludedDirs.sort()).toEqual(['-home-me-secret-thing', 'ops']);
    expect(r.sessions).toBe(2);
    expect(r.byAgent).toEqual({ gemini: { sessions: 1, claims: 1, verified: 1 }, qwen: { sessions: 1, claims: 1, verified: 1 } });
    expect(r.claims.map((c) => [c.agent, c.project])).toEqual([
      ['gemini', '/work/app'],
      ['qwen', cwd],
    ]);
    expect(r.geminiDir).toBe(gemini);
    expect(r.qwenDir).toBe(qwen);
    const all = await scanHistory(base);
    expect(all.sessions).toBe(4);
    const none = await scanHistory({ ...base, since: new Date('2030-01-01') });
    expect(none.sessions).toBe(0);
    expect(none.skippedFiles).toBe(4);
    const off = await scanHistory({ ...base, geminiDir: null, qwenDir: null });
    expect(off.sessions).toBe(0);
  });
});
