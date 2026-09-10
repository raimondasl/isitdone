/**
 * Cursor transcript fixtures. The agent-transcripts JSONL lines follow the shape of a real captured session (entireio
 * testdata/real_session_tool_use.jsonl, 2026-08-24). The state.vscdb rows (composerData, bubbleId, composer.composerHeaders,
 * workspace composer.composerData) are RECONSTRUCTED from published parsers and format docs (toolpath, cursaves,
 * cursor-history, opik), not copied from an observed database: no Cursor install was available.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cursorTranscriptFiles, loadSqlite, openCursorStore, scanCursorTranscript, uriToPath } from '../src/cursor.js';
import { scanHistory } from '../src/history.js';
import type { ClaimRecord } from '../src/turns.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  dir = null;
});

type Rec = Record<string, unknown>;
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
let t = Date.parse('2026-09-01T10:00:00Z');
const tick = () => new Date((t += 60_000)).toISOString();

function write(rel: string, content: string): string {
  const p = join(dir as string, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// --- agent-transcripts JSONL (real shape) ---
const u = (text: string): Rec => ({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>Monday, Aug 24, 2026, 3:01 PM (UTC-5)</timestamp>\n<user_query>\n${text}\n</user_query>` }] } });
const a = (text: string, tool?: Rec): Rec => ({ role: 'assistant', message: { content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use', ...tool }] : [])] } });
const writeTool = { name: 'Write', input: { path: '/tmp/cursor-probe/notes.md', contents: 'line 1\n' } };
const strReplace = { name: 'StrReplace', input: { new_string: 'line 7 CHANGED', old_string: 'line 7', path: '/tmp/cursor-probe/notes.md' } };
const shell = (command: string): Rec => ({ name: 'Shell', input: { command, description: 'run', working_directory: '/tmp/cursor-probe' } });
const ended = { type: 'turn_ended', status: 'success' };
const jsonl = (records: Rec[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const transcript = () => jsonl([u('fix the test'), a('Editing.\n\n[REDACTED]', writeTool), a('[REDACTED]', shell('npm test')), a('Done. All tests pass.'), ended, u('more'), a('[REDACTED]', strReplace), a('Done.'), ended]);

const NONE = { codexDir: null, geminiDir: null, qwenDir: null };

describe('Cursor agent-transcripts (JSONL fallback)', () => {
  it('finds IDE, CLI and subagent layouts; edits and commands are read, test runs have no exit code, sessions are flagged lossy', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-cursor-'));
    const cursorDir = join(dir, '.cursor');
    const ide = uid();
    const cli = uid();
    const sub = uid();
    write(`.cursor/projects/Users-me-app/agent-transcripts/${ide}/${ide}.jsonl`, transcript());
    write('.cursor/projects/Users-me-app/repo.json', JSON.stringify({ workspace: '/Users/me/app' }));
    write(`.cursor/projects/Users-me-lib/agent-transcripts/${cli}.jsonl`, transcript());
    write(`.cursor/projects/Users-me-lib/agent-transcripts/subagents/${sub}/${sub}.jsonl`, transcript());
    write('.cursor/projects/1775744516184/repo.json', '{}');
    expect(cursorTranscriptFiles(cursorDir, null).files.map((f) => [f.slug, f.label])).toEqual([
      ['Users-me-app', '/Users/me/app'],
      ['Users-me-lib', 'cursor:Users-me-lib'],
    ]);
    expect(cursorTranscriptFiles(cursorDir, null, true).files).toHaveLength(3);
    expect(cursorTranscriptFiles(cursorDir, new Date('2030-01-01')).skipped).toBe(2);

    const out: ClaimRecord[] = [];
    const stats = { editTurns: 0 };
    scanCursorTranscript(join(cursorDir, 'projects', 'Users-me-app', 'agent-transcripts', ide, `${ide}.jsonl`), {}, '/Users/me/app', out, stats);
    expect(stats.editTurns).toBe(2);
    expect(out.map((c) => [c.verdict, c.agent, c.project, c.session, c.claim, c.lossy])).toEqual([
      ['VERIFIED', 'cursor', '/Users/me/app', ide, 'All tests pass.', true],
      ['NEVER_RAN', 'cursor', '/Users/me/app', ide, 'Done.', true],
    ]);
    // line order stands in for time: the claim is dated by the file's mtime
    expect(Date.parse(out[0]?.at ?? '')).toBeGreaterThan(Date.now() - 60_000);

    const r = await scanHistory({ ...NONE, projectsDir: join(dir, 'nope'), cursorDir, cursorUserDir: null });
    expect(r.cursorSource).toBe('transcripts');
    expect(r.byAgent.cursor).toEqual({ sessions: 2, claims: 4, verified: 2, lossy: 2 });
    expect(r.claims.every((c) => c.lossy === true)).toBe(true);
    const ex = await scanHistory({ ...NONE, projectsDir: join(dir, 'nope'), cursorDir, cursorUserDir: null, exclude: ['me-lib'] });
    expect(ex.excludedDirs).toEqual(['Users-me-lib']);
    expect(ex.sessions).toBe(1);
    // no node:sqlite and no user dir: only the transcripts
    const off = await scanHistory({ ...NONE, projectsDir: join(dir, 'nope'), cursorDir, cursorUserDir: join(dir, 'Cursor', 'User'), cursorSqlite: false });
    expect(off.cursorSource).toBe('transcripts');
    expect(off.sessions).toBe(2);
    const nothing = await scanHistory({ ...NONE, projectsDir: join(dir, 'nope'), cursorDir: null, cursorUserDir: null });
    expect(nothing.sessions).toBe(0);
    expect(nothing.cursorSource).toBeNull();
  });

  it('uriToPath decodes VS Code folder URIs', () => {
    const here = process.cwd();
    expect(uriToPath(pathToFileURL(here).href)).toBe(here);
    expect(uriToPath('vscode-remote://ssh-remote%2Bhost/path/on/remote')).toBe('vscode-remote://ssh-remote+host/path/on/remote');
  });

  it('loadSqlite never throws and is consistent', () => {
    const m = loadSqlite();
    expect(m === null || typeof m.DatabaseSync === 'function').toBe(true);
    expect(loadSqlite()).toBe(m);
    expect(openCursorStore(tmpdir(), { sqlite: null })).toBeNull();
  });
});

// --- state.vscdb bubbles (reconstructed) ---
interface WritableSqlite {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): unknown }; close(): void };
}
let bn = 1000;
/** Bubble ids DEcrease so that the key order in the DB is the reverse of the conversation order. */
const bid = () => `${String(--bn).padStart(8, '0')}-bbbb-4000-8000-000000000000`;
const bubble = (extra: Rec): Rec => ({ _v: 3, bubbleId: bid(), type: 2, text: '', createdAt: tick(), capabilityType: null, toolResults: [], ...extra });
const userB = (text: string) => bubble({ type: 1, text });
const textB = (text: string) => bubble({ text });
const thinkB = () => bubble({ capabilityType: 30, text: 'Done thinking.', allThinkingBlocks: [{ text: 'hmm' }] });
const editB = (status = 'completed') => bubble({ capabilityType: 15, toolFormerData: { tool: 38, toolIndex: 0, modelCallId: '', toolCallId: `tool_${uid()}`, status, name: 'edit_file_v2', params: JSON.stringify({ relativeWorkspacePath: '/Users/me/app/src/a.ts', noCodeblock: true, cloudAgentEdit: false }), result: status === 'completed' ? JSON.stringify({ beforeContentId: 'composer.content.a', afterContentId: 'composer.content.b' }) : null, additionalData: {} } });
const termB = (command: string, result: Rec | null, extra: Rec = {}) => bubble({ capabilityType: 15, toolFormerData: { tool: 15, toolIndex: 0, modelCallId: '', toolCallId: `tool_${uid()}`, status: 'completed', name: 'run_terminal_command_v2', params: JSON.stringify({ command, cwd: '', options: { timeout: 30000 }, commandDescription: 'run' }), result: result ? JSON.stringify(result) : null, additionalData: {}, ...extra } });
const placeholderB = () => bubble({ text: 'Looking at the code.', toolFormerData: { additionalData: { status: 'error' } } });

const hasSqlite = loadSqlite() !== null;

describe.skipIf(!hasSqlite)('Cursor bubble store (node:sqlite)', () => {
  it('maps composers to workspaces, reads edits and exit codes from toolFormerData, skips chat and subagent composers, dedupes the JSONL', async () => {
    dir = mkdtempSync(join(tmpdir(), 'isitdone-cursor-'));
    const userDir = join(dir, 'Cursor', 'User');
    const cursorDir = join(dir, '.cursor');
    const lib = join(dir, 'work', 'lib');
    mkdirSync(join(userDir, 'globalStorage'), { recursive: true });
    mkdirSync(join(userDir, 'workspaceStorage', 'ws2'), { recursive: true });
    mkdirSync(lib, { recursive: true });
    const sqlite = loadSqlite() as unknown as WritableSqlite;
    const db = new sqlite.DatabaseSync(join(userDir, 'globalStorage', 'state.vscdb'));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA wal_autocheckpoint=0'); // everything stays in the -wal while the "editor" is running
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const put = (table: string, key: string, value: unknown) => db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`).run(key, Buffer.from(JSON.stringify(value)));
    const C1 = uid();
    const C2 = uid();
    const C3 = `task-toolu_${uid()}`;
    const C4 = uid();
    const composer = (id: string, bubbles: Rec[], extra: Rec = {}) => {
      const ms = t;
      put('cursorDiskKV', `composerData:${id}`, { _v: 16, composerId: id, name: 'x', createdAt: ms - 3_600_000, lastUpdatedAt: ms, unifiedMode: 'agent', isAgentic: true, status: 'completed', conversationMap: {}, fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type })), ...extra });
      // rows inserted in reverse so the ordering must come from the manifest, not the key order
      for (const b of [...bubbles].reverse()) put('cursorDiskKV', `bubbleId:${id}:${b.bubbleId}`, b);
    };
    composer(C1, [
      userB('fix the test'),
      thinkB(),
      editB(),
      termB('npm test', { output: 'FAIL src/a.test.ts', exitCode: 1, rejected: false, notInterrupted: true }),
      textB('Done, tests pass.'),
      userB('again'),
      placeholderB(),
      editB(),
      termB('npm test', { output: '3 passed', exitCode: 0, rejected: false, notInterrupted: true }),
      textB('All green.'),
      userB('and'),
      editB(),
      termB('npm test', { rejected: true }, { userDecision: 'rejected' }),
      textB('Done.'),
      userB('last'),
      editB(),
      termB('npm test', { output: 'ok', exitCodeV2: 0, rejected: false, notInterrupted: true }),
      editB(),
      textB('Done.'),
      userB('edit failed'),
      editB('error'),
      textB('Done.'),
    ]);
    composer(C2, [userB('what does this do?'), textB('It parses. Done.')], { unifiedMode: 'chat', isAgentic: false });
    composer(C3, [userB('explore'), editB(), textB('Done.')]);
    composer(C4, [userB('go'), editB(), termB('npx vitest run', { output: 'ok', exitCode: 0, rejected: false, notInterrupted: true }), textB('Done, tests pass.')]);
    // Cursor 3.0+ index knows C1 (and the chat C2); C4 is only known to its pre-3.0 workspace DB
    put('ItemTable', 'composer.composerHeaders', {
      allComposers: [
        { type: 'head', composerId: C1, name: 'x', unifiedMode: 'agent', workspaceIdentifier: { id: 'ws1', uri: { $mid: 1, fsPath: '/Users/me/app', external: 'file:///Users/me/app', path: '/Users/me/app', scheme: 'file' } } },
        { type: 'head', composerId: C2, name: 'y', unifiedMode: 'chat', workspaceIdentifier: { id: '1775744516184' } },
        { type: 'head', composerId: C3, name: 'sub', unifiedMode: 'agent', workspaceIdentifier: { id: 'ws1', uri: { $mid: 1, fsPath: '/Users/me/app', external: 'file:///Users/me/app', path: '/Users/me/app', scheme: 'file' } } },
      ],
    });
    writeFileSync(join(userDir, 'workspaceStorage', 'ws2', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(lib).href }));
    const wdb = new sqlite.DatabaseSync(join(userDir, 'workspaceStorage', 'ws2', 'state.vscdb'));
    wdb.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    wdb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('composer.composerData', Buffer.from(JSON.stringify({ allComposers: [{ composerId: C4, name: 'z', createdAt: t, lastUpdatedAt: t, unifiedMode: 'agent' }], selectedComposerIds: [C4] })));
    wdb.close();
    // the IDE also wrote C1's JSONL (must not be counted twice); a Cursor CLI session exists only as JSONL
    const cli = uid();
    write(`.cursor/projects/Users-me-app/agent-transcripts/${C1}/${C1}.jsonl`, transcript());
    write(`.cursor/projects/Users-me-app/agent-transcripts/${cli}.jsonl`, transcript());

    const base = { ...NONE, projectsDir: join(dir, 'nope'), cursorDir, cursorUserDir: userDir };
    // 1: read in place while the writer connection is still open (Cursor running, WAL not checkpointed)
    const r = await scanHistory(base);
    expect(r.cursorSource).toBe('sqlite+transcripts');
    expect(r.byAgent.cursor).toEqual({ sessions: 3, claims: 7, verified: 3, lossy: 1 });
    expect(r.editTurns).toBe(7);
    const c1 = r.claims.filter((c) => c.session === C1);
    expect(c1.map((c) => [c.verdict, c.claim, c.project])).toEqual([
      ['FAILED', 'Done, tests pass.', '/Users/me/app'],
      ['VERIFIED', 'All green.', '/Users/me/app'],
      ['NEVER_RAN', 'Done.', '/Users/me/app'],
      ['STALE', 'Done.', '/Users/me/app'],
    ]);
    expect(c1[0]?.at.slice(0, 10)).toBe('2026-09-01');
    expect(c1.every((c) => c.lossy === undefined)).toBe(true);
    expect(r.claims.filter((c) => c.session === C4).map((c) => [c.verdict, c.project])).toEqual([['VERIFIED', lib]]);
    expect(r.claims.filter((c) => c.session === cli).map((c) => [c.verdict, c.lossy])).toEqual([
      ['VERIFIED', true],
      ['NEVER_RAN', true],
    ]);
    expect(r.claims.some((c) => c.session === C2 || c.session === C3)).toBe(false);
    // subagent composers on request; exclusions match the resolved workspace before any bubble is read
    expect((await scanHistory({ ...base, includeSubagents: true })).byAgent.cursor?.sessions).toBe(4);
    const ex = await scanHistory({ ...base, exclude: ['lib'] });
    expect(ex.excludedDirs).toEqual([lib]);
    expect(ex.byAgent.cursor?.sessions).toBe(2);
    const old = await scanHistory({ ...base, since: new Date('2030-01-01') });
    expect(old.byAgent.cursor).toBeUndefined();
    // 2: after the editor closes (WAL checkpointed into the main file) the result is the same
    db.close();
    const again = await scanHistory(base);
    expect(again.byAgent.cursor).toEqual({ sessions: 3, claims: 7, verified: 3, lossy: 1 });
    const store = openCursorStore(userDir);
    expect(store?.composers().map((c) => [c.id, c.project, c.agentic, c.subagent]).sort()).toEqual(
      [
        [C1, '/Users/me/app', true, false],
        [C2, null, false, false],
        [C3, '/Users/me/app', true, true],
        [C4, lib, true, false],
      ].sort(),
    );
    store?.close();
  });
});
