/**
 * Gemini CLI and Qwen Code chat transcripts for `isitdone history`.
 *
 * Gemini CLI: ~/.gemini/tmp/<project-id>/chats/session-<YYYY-MM-DDTHH-mm>-<id8>.json (v0.2 to v0.38: one ConversationRecord)
 * or .jsonl (v0.39+, append-only: a metadata line, then MessageRecords keyed by `id` where a later line with the same id
 * replaces the earlier one, {"$set":{...}} metadata patches whose `messages` array replaces every message, and
 * {"$rewindTo":id} which drops that message and everything after it). <project-id> is a sha256 of the project root
 * (until v0.28) or a short slug (v0.29+) whose dir carries a `.project_root` marker and an entry in ~/.gemini/projects.json.
 * Qwen Code (a Gemini CLI fork with its own session store, v0.4+): ~/.qwen/projects/<sanitized-cwd>/chats/<uuid>.jsonl,
 * one ChatRecord per line (user / assistant / tool_result / system), cwd on every record.
 * Both: model text in the record content; edits are `replace`/`write_file`/`edit` tool calls with status success; shell
 * commands are `run_shell_command` whose output text carries "Exit Code: N" (always in Qwen and pre-2026 Gemini builds,
 * only for non-zero exits in current Gemini builds).
 * // verified: gemini-cli chatRecordingService.ts / projectRegistry.ts / shell.ts, qwen-code chatRecordingService.ts /
 * // storage.ts / paths.ts (main, 2026-09-07); no real session file was available, so the shapes are reconstructed.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { TurnTracker, ts, type ClaimRecord, type TurnStats } from './turns.js';

type Rec = Record<string, unknown>;

export interface AgentSessionFile {
  file: string;
  /** Directory name the session was found under (matched by --exclude). */
  slug: string;
  /** Project label to report when the transcript itself says nothing better. */
  label: string;
}

/** Edit tools: Gemini `replace`/`write_file`, Qwen `edit` (alias `replace`), `write_file`, `notebook_edit`. */
const EDIT_TOOLS = new Set(['replace', 'write_file', 'edit', 'notebook_edit', 'edit_file', 'create_file', 'smart_edit']);
const SHELL_TOOLS = new Set(['run_shell_command', 'shell', 'bash', 'execute_bash_command']);

function obj(v: unknown): Rec | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function tooOld(p: string, since: Date | null): boolean | null {
  try {
    return since !== null && statSync(p).mtimeMs < since.getTime();
  } catch {
    return null;
  }
}

export function defaultGeminiDir(): string {
  // GEMINI_CLI_HOME replaces the home directory, not the .gemini dir (gemini-cli utils/paths.ts homedir()).
  const home = process.env.GEMINI_CLI_HOME && process.env.GEMINI_CLI_HOME !== '' ? process.env.GEMINI_CLI_HOME : homedir();
  return join(home, '.gemini');
}

export function defaultQwenDir(): string {
  // QWEN_HOME is the .qwen dir itself (qwen-code config/storage.ts getGlobalQwenDir()).
  return process.env.QWEN_HOME && process.env.QWEN_HOME !== '' ? process.env.QWEN_HOME : join(homedir(), '.qwen');
}

/** slug -> project path from ~/.gemini/projects.json ({"projects": {"<path>": "<slug>"}}), v0.29+. */
function geminiRegistry(geminiDir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const j = JSON.parse(readFileSync(join(geminiDir, 'projects.json'), 'utf8')) as { projects?: Record<string, unknown> };
    for (const [path, slug] of Object.entries(obj(j.projects) ?? {})) if (typeof slug === 'string' && !map.has(slug)) map.set(slug, path);
  } catch {
    // no registry (pre-0.29 install, or unreadable)
  }
  return map;
}

/** Label for a Gemini project dir: the .project_root marker, else the registry, else the id itself. */
export function geminiProjectLabel(geminiDir: string, id: string, registry?: Map<string, string>): string {
  try {
    const owner = readFileSync(join(geminiDir, 'tmp', id, '.project_root'), 'utf8').trim();
    if (owner) return owner;
  } catch {
    // no marker (hash-named dir from an older build, or a slug dir never re-registered)
  }
  return (registry ?? geminiRegistry(geminiDir)).get(id) ?? `gemini:${id}`;
}

/** Gemini CLI session files under <geminiDir>/tmp/<project-id>/chats. Subagent sessions nest one level deeper. */
export function geminiSessionFiles(geminiDir: string, since: Date | null, includeSubagents = false): { files: AgentSessionFile[]; skipped: number } {
  const files: AgentSessionFile[] = [];
  let skipped = 0;
  const tmp = join(geminiDir, 'tmp');
  if (!isDir(tmp)) return { files, skipped };
  const registry = geminiRegistry(geminiDir);
  const consider = (p: string, slug: string, label: string) => {
    const old = tooOld(p, since);
    if (old === null || old) skipped++;
    else files.push({ file: p, slug, label });
  };
  for (const id of readdirSync(tmp)) {
    const chats = join(tmp, id, 'chats');
    if (!isDir(chats)) continue;
    let label: string | null = null;
    for (const f of readdirSync(chats)) {
      const p = join(chats, f);
      if (/^session-.*\.jsonl?$/.test(f)) {
        if (!isDir(p)) consider(p, id, (label ??= geminiProjectLabel(geminiDir, id, registry)));
      } else if (includeSubagents && isDir(p)) {
        for (const s of readdirSync(p)) if (s.endsWith('.jsonl')) consider(join(p, s), id, (label ??= geminiProjectLabel(geminiDir, id, registry)));
      }
    }
  }
  return { files, skipped };
}

/** Qwen Code session files under <qwenDir>/projects/<sanitized-cwd>/chats/<uuid>.jsonl (sidecars like <id>.ledger.jsonl excluded). */
export function qwenSessionFiles(qwenDir: string, since: Date | null): { files: AgentSessionFile[]; skipped: number } {
  const files: AgentSessionFile[] = [];
  let skipped = 0;
  const projects = join(qwenDir, 'projects');
  if (!isDir(projects)) return { files, skipped };
  for (const slug of readdirSync(projects)) {
    const chats = join(projects, slug, 'chats');
    if (!isDir(chats)) continue;
    for (const f of readdirSync(chats)) {
      if (!/^[0-9a-fA-F-]{32,36}\.jsonl$/.test(f)) continue;
      const p = join(chats, f);
      const old = tooOld(p, since);
      if (old === null || old) skipped++;
      else files.push({ file: p, slug, label: `qwen:${slug}` });
    }
  }
  return { files, skipped };
}

/** Text of a Gemini `content` / Part[] (strings, text parts; thought parts skipped). */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : content ? [content] : [];
  const texts: string[] = [];
  for (const p of parts) {
    const o = obj(p);
    if (o && typeof o.text === 'string' && o.thought !== true) texts.push(o.text);
  }
  return texts.join('\n');
}

/** Every part is a functionResponse (a synthetic tool-result turn), so the record is not a user prompt. */
function onlyFunctionResponses(content: unknown): boolean {
  const parts = Array.isArray(content) ? content : [];
  return parts.length > 0 && parts.every((p) => obj(p)?.functionResponse !== undefined);
}

/** Output text inside a tool result (Part[] of functionResponse parts, or plain text parts). */
function resultText(result: unknown): string {
  const parts = Array.isArray(result) ? result : result ? [result] : [];
  const texts: string[] = [];
  for (const p of parts) {
    const o = obj(p);
    if (!o) continue;
    if (typeof o.text === 'string') texts.push(o.text);
    const resp = obj(obj(o.functionResponse)?.response);
    if (resp) {
      if (typeof resp.output === 'string') texts.push(resp.output);
      else if (typeof resp.error === 'string') texts.push(resp.error);
      else if (typeof resp.content === 'string') texts.push(resp.content);
    }
  }
  return texts.join('\n');
}

export interface ShellOutcome {
  /** The command completed (was not cancelled, backgrounded or timed out before it could finish). */
  ran: boolean;
  /** Exit status, or null when the output does not say. */
  ok: boolean | null;
}

/**
 * What a run_shell_command result says. Current Gemini: "Output: ...", then "Exit Code: N" only when N != 0 (a success
 * has no exit line, so status success means 0). Qwen and pre-2026 Gemini: "Command: ...\nDirectory: ...\nOutput: ...\n
 * Error: ...\nExit Code: <n or (none)>\nSignal: ...\nProcess Group PGID: ...", the exit line always present.
 * `display` is the ToolCallRecord.resultDisplay, "Command exited with code: N" for a failed command.
 */
export function geminiShellOutcome(output: string, status: string | undefined, display?: unknown): ShellOutcome {
  if (status === 'cancelled') return { ran: false, ok: null };
  if (/^Command (?:was )?(?:automatically )?cancelled\b|^Command moved to background\b|^Command (?:was )?(?:promoted|backgrounded)\b/m.test(output)) return { ran: false, ok: null };
  const m = /^Exit Code: (-?\d+)\s*$/m.exec(output);
  if (m) return { ran: true, ok: Number(m[1]) === 0 };
  const d = typeof display === 'string' ? /^Command exited with code: (-?\d+)/.exec(display) : null;
  if (d) return { ran: true, ok: Number(d[1]) === 0 };
  if (/^Command terminated by signal|^Signal: (?!\(none\))\S/m.test(output)) return { ran: true, ok: false };
  if (status === 'success') return { ran: true, ok: true };
  if (status === 'error') return { ran: true, ok: false };
  return { ran: true, ok: null };
}

async function readLines(file: string): Promise<string[]> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const l of rl) lines.push(l);
  } finally {
    rl.close();
    await new Promise<void>((resolve) => {
      if (stream.destroyed || stream.closed) return resolve();
      stream.once('close', () => resolve());
      stream.destroy();
    });
  }
  return lines;
}

/** Messages of a Gemini session file in conversation order, with the metadata seen (kind, projectHash). */
export async function loadGeminiMessages(file: string): Promise<{ messages: Rec[]; meta: Rec }> {
  const messages = new Map<string, Rec>();
  let meta: Rec = {};
  const setAll = (list: unknown) => {
    for (const m of Array.isArray(list) ? list : []) {
      const o = obj(m);
      if (o && typeof o.id === 'string') messages.set(o.id, o);
    }
  };
  const apply = (rec: Rec) => {
    if (typeof rec.$rewindTo === 'string') {
      // As the CLI's own loader: drop the target and everything after it, nothing when the target is unknown.
      const ids = [...messages.keys()];
      const at = ids.indexOf(rec.$rewindTo);
      if (at >= 0) for (const id of ids.slice(at)) messages.delete(id);
    } else if (typeof rec.id === 'string') {
      // A later line with the same id replaces the earlier one; the original position is kept (Map semantics, as in
      // the CLI's own loader), which is how tool calls get attached to an already-written model message.
      messages.set(rec.id, rec);
    } else if (obj(rec.$set)) {
      const set = rec.$set as Rec;
      if (Array.isArray(set.messages)) {
        messages.clear();
        setAll(set.messages);
      }
      meta = { ...meta, ...set };
    } else if (typeof rec.sessionId === 'string' && typeof rec.projectHash === 'string') {
      meta = { ...meta, ...rec };
      if (Array.isArray(rec.messages)) setAll(rec.messages);
    }
  };
  const whole = (): boolean => {
    try {
      const j = obj(JSON.parse(readFileSync(file, 'utf8')));
      if (!j || !Array.isArray(j.messages)) return false;
      meta = { ...meta, ...j };
      setAll(j.messages);
      return true;
    } catch {
      return false;
    }
  };
  const lines = async () => {
    for (const line of await readLines(file)) {
      if (!line.startsWith('{')) continue;
      try {
        const rec = obj(JSON.parse(line));
        if (rec) apply(rec);
      } catch {
        // skip malformed line
      }
    }
  };
  if (file.endsWith('.json')) {
    // Pre-0.39: one pretty-printed record; a renamed-but-not-migrated file may still be JSONL.
    if (!whole()) await lines();
  } else {
    await lines();
    if (messages.size === 0 && !meta.sessionId) whole();
  }
  return { messages: [...messages.values()], meta };
}

export async function scanGeminiSession(file: string, opts: { since?: Date | null; includeSubagents?: boolean }, label: string, out: ClaimRecord[], stats: TurnStats): Promise<void> {
  const { messages, meta } = await loadGeminiMessages(file);
  if (meta.kind === 'subagent' && !opts.includeSubagents) return;
  const session = basename(file).replace(/\.jsonl?$/, '');
  const turn = new TurnTracker({ project: () => label, session, agent: 'gemini', sinceMs: opts.since ? opts.since.getTime() : 0 }, out, stats);
  for (const m of messages) {
    const at = ts(m.timestamp);
    if (m.type === 'user') {
      if (onlyFunctionResponses(m.content)) continue;
      turn.finalize();
      turn.prompt();
      continue;
    }
    if (m.type !== 'gemini') continue; // info / error / warning notices
    const text = partsText(m.content);
    if (text.trim()) turn.text(text, at);
    for (const tc of Array.isArray(m.toolCalls) ? (m.toolCalls as unknown[]) : []) {
      const call = obj(tc);
      if (!call) continue;
      const name = typeof call.name === 'string' ? call.name : '';
      const status = typeof call.status === 'string' ? call.status : undefined;
      const callAt = ts(call.timestamp) || at;
      if (EDIT_TOOLS.has(name)) {
        if (status === 'success') turn.edit(callAt);
      } else if (SHELL_TOOLS.has(name)) {
        const args = obj(call.args) ?? {};
        const cmd = typeof args.command === 'string' ? args.command : '';
        if (!cmd) continue;
        const o = geminiShellOutcome(resultText(call.result), status, call.resultDisplay);
        if (o.ran) turn.ran(cmd, o.ok, callAt);
      }
    }
  }
  turn.finalize();
}

/** Qwen user records that continue a turn rather than start one (mirrors the CLI's own resume logic). */
const QWEN_NON_PROMPT = new Set(['goal_runtime', 'notification', 'cron', 'mid_turn_user_message', 'realtime_message']);

export async function scanQwenSession(file: string, opts: { since?: Date | null; includeSubagents?: boolean }, project: { label: string; sawCwd: (cwd: string) => void }, out: ClaimRecord[], stats: TurnStats): Promise<void> {
  const session = basename(file, '.jsonl');
  let cwd: string | null = null;
  const turn = new TurnTracker({ project: () => cwd ?? project.label, session, agent: 'qwen', sinceMs: opts.since ? opts.since.getTime() : 0 }, out, stats);
  /** Edit tool calls awaiting their tool_result (call id -> tool name). */
  const edits = new Map<string, string>();
  for (const line of await readLines(file)) {
    if (!line.startsWith('{')) continue;
    let j: Rec;
    try {
      j = JSON.parse(line) as Rec;
    } catch {
      continue;
    }
    if (j.isSidechain === true && !opts.includeSubagents) continue;
    if (typeof j.cwd === 'string' && j.cwd) {
      if (!cwd) project.sawCwd(j.cwd);
      cwd = j.cwd;
    }
    const at = ts(j.timestamp);
    const message = obj(j.message);
    const parts = message && Array.isArray(message.parts) ? (message.parts as unknown[]) : [];
    if (j.type === 'user') {
      if (typeof j.subtype === 'string' && QWEN_NON_PROMPT.has(j.subtype)) continue;
      if (onlyFunctionResponses(parts)) continue;
      turn.finalize();
      turn.prompt();
    } else if (j.type === 'assistant') {
      const text = partsText(parts);
      if (text.trim()) turn.text(text, at);
      for (const p of parts) {
        const fc = obj(obj(p)?.functionCall);
        if (!fc) continue;
        const name = typeof fc.name === 'string' ? fc.name : '';
        const id = typeof fc.id === 'string' && fc.id ? fc.id : name;
        if (EDIT_TOOLS.has(name)) edits.set(id, name);
        else if (SHELL_TOOLS.has(name)) {
          const args = obj(fc.args) ?? {};
          if (typeof args.command === 'string') turn.command(id, args.command, at);
        }
      }
    } else if (j.type === 'tool_result') {
      const result = obj(j.toolCallResult) ?? {};
      const status = typeof result.status === 'string' ? result.status : undefined;
      for (const p of parts) {
        const fr = obj(obj(p)?.functionResponse);
        if (!fr) continue;
        const name = typeof fr.name === 'string' ? fr.name : '';
        const id = typeof fr.id === 'string' && fr.id ? fr.id : name;
        const resp = obj(fr.response) ?? {};
        if (edits.has(id) || EDIT_TOOLS.has(name)) {
          edits.delete(id);
          if (status === 'success' || (status === undefined && result.error === undefined && resp.error === undefined)) turn.edit(at);
        } else if (turn.isPending(id) || SHELL_TOOLS.has(name)) {
          const o = geminiShellOutcome(resultText([p]), status, result.resultDisplay);
          if (o.ran) turn.resolve(id, o.ok, at);
          else turn.forget(id);
        }
      }
    } else if (j.type === 'system' && j.subtype === 'turn_result') {
      // Newer builds close every turn with its final text; the assistant record already carried it, this just confirms.
      const sp = obj(j.systemPayload) ?? {};
      if (sp.state === 'completed' && typeof sp.resultText === 'string') turn.text(sp.resultText, at);
    }
  }
  turn.finalize();
}
