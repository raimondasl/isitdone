/**
 * Codex CLI rollout transcripts for `isitdone history`.
 * Files: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl (older: flat sessions/*.jsonl), archived_sessions/*.jsonl,
 * optionally zstd-compressed after 7 days (*.jsonl.zst). Each line is {timestamp, type, payload}; the first is session_meta.
 * Both history modes are handled: legacy (response_item/event_msg lines) and paginated (item_completed items).
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import * as zlib from 'node:zlib';
import { TurnTracker, ts, type ClaimRecord, type TurnStats } from './turns.js';

const CONTEXTUAL_PREFIXES = ['<user_instructions>', '<environment_context>', '<environments_instructions>', '<apps_instructions>', '<skills_instructions>', '<plugins_instructions>', '<tools>', '<collaboration_mode>', '<multi_agent_mode>', '<realtime_conversation>', '<context_window>', '<context_window_guidance>', '<rollout_budget>', '<token_budget>', '<permissions instructions>', '<model_switch>', '<managed_developer_instructions>', '<persistent_mode>', '<multi_agent_role>', '<git_attribution>', '<personality_spec>'];

/** All rollout files under a Codex home, newest layout and old flat layout, plus archived sessions. */
export function codexSessionFiles(codexDir: string, since: Date | null): { files: string[]; skipped: number } {
  const files: string[] = [];
  let skipped = 0;
  const consider = (p: string) => {
    if (!/^rollout-.*\.jsonl(?:\.zst)?$/.test(basename(p))) return;
    if (p.endsWith('.zst') && typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync !== 'function') {
      skipped++;
      return;
    }
    try {
      if (since && statSync(p).mtimeMs < since.getTime()) {
        skipped++;
        return;
      }
    } catch {
      skipped++;
      return;
    }
    files.push(p);
  };
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else consider(p);
    }
  };
  const sessions = join(codexDir, 'sessions');
  if (existsSync(sessions)) walk(sessions, 0);
  const archived = join(codexDir, 'archived_sessions');
  if (existsSync(archived)) walk(archived, 0);
  return { files, skipped };
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Text of a user/assistant `message` response item, or null when it is injected context rather than a prompt. */
function messageText(payload: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const c of Array.isArray(payload.content) ? (payload.content as Array<Record<string, unknown>>) : []) {
    const t = c && typeof c.text === 'string' ? c.text : null;
    if (t !== null && (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')) parts.push(t);
  }
  if (parts.length === 0) return null;
  let text = parts.join('\n');
  const lower = text.trimStart().toLowerCase();
  if (CONTEXTUAL_PREFIXES.some((p) => lower.startsWith(p))) return null;
  const marker = '## My request for Codex:';
  const i = text.indexOf(marker);
  if (i >= 0) text = text.slice(i + marker.length);
  return text.trim() === '' ? null : text;
}

/** Shell command text from a function_call's arguments (exec_command, shell, shell_command, unified_exec). */
function commandOf(payload: Record<string, unknown>): string | null {
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (!/^(?:exec_command|shell|shell_command|unified_exec|container\.exec|bash)$/.test(name)) return null;
  let args: Record<string, unknown> = {};
  try {
    args = typeof payload.arguments === 'string' ? (JSON.parse(payload.arguments) as Record<string, unknown>) : (obj(payload.arguments) ?? {});
  } catch {
    return null;
  }
  const c = args.cmd ?? args.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return null;
}

/** Session id polled by a write_stdin call (Codex keeps a command running past its yield time and reports the exit later). */
function stdinSession(payload: Record<string, unknown>): string | null {
  if (payload.name !== 'write_stdin') return null;
  try {
    const args = typeof payload.arguments === 'string' ? (JSON.parse(payload.arguments) as Record<string, unknown>) : (obj(payload.arguments) ?? {});
    const sid = args.session_id;
    return typeof sid === 'number' || (typeof sid === 'string' && sid !== '') ? String(sid) : null;
  } catch {
    return null;
  }
}

export interface CommandOutcome {
  /** Exit status, or null when the output does not say. */
  ok: boolean | null;
  /** Session id when the process is still running (the exit code arrives with a later write_stdin output). */
  running: string | null;
  /** The command was declined at the approval prompt and never ran. */
  rejected: boolean;
}

/**
 * What a function_call_output says about its command. Headers seen in the wild: "Process exited with code N" and
 * "Process running with session ID N" (unified exec), "Exit code: N" (freeform shell), and the pre-0.60 JSON metadata.
 */
export function commandOutcome(output: unknown): CommandOutcome {
  const text = typeof output === 'string' ? output : Array.isArray(output) ? output.map((c) => (obj(c)?.text as string) ?? '').join('\n') : '';
  const none: CommandOutcome = { ok: null, running: null, rejected: false };
  const exited = /^Process exited with code (-?\d+)\s*$/m.exec(text) ?? /^Exit code: (-?\d+)\s*$/m.exec(text);
  if (exited) return { ...none, ok: Number(exited[1]) === 0 };
  const running = /^Process running with session ID (\S+)\s*$/m.exec(text);
  if (running) return { ...none, running: running[1] as string };
  if (text.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(text) as { metadata?: { exit_code?: number } };
      if (j.metadata && typeof j.metadata.exit_code === 'number') return { ...none, ok: j.metadata.exit_code === 0 };
    } catch {
      // not JSON
    }
  }
  if (/^(?:exec command rejected|command rejected|rejected by user|approval (?:denied|rejected)|user (?:declined|rejected))/im.test(text)) return { ...none, rejected: true };
  if (/^(?:command failed|error:|FAIL\b|failed)/im.test(text) && /exit(?:ed)? (?:with )?(?:code |status )?[1-9]/i.test(text)) return { ...none, ok: false };
  return none;
}

/** Exit status from a function_call_output, or null when it is unknown (still running, rejected, unparseable). */
export function exitOk(output: unknown): boolean | null {
  return commandOutcome(output).ok;
}

async function readLines(file: string): Promise<AsyncIterable<string>> {
  if (file.endsWith('.zst')) {
    const decompress = (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync;
    const text = decompress(readFileSync(file)).toString('utf8');
    return (async function* () {
      for (const l of text.split('\n')) yield l;
    })();
  }
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  return (async function* () {
    try {
      for await (const l of rl) yield l;
    } finally {
      rl.close();
      await new Promise<void>((resolve) => {
        if (stream.destroyed || stream.closed) return resolve();
        stream.once('close', () => resolve());
        stream.destroy();
      });
    }
  })();
}

export async function scanCodexSession(file: string, opts: { since?: Date | null }, out: ClaimRecord[], stats: TurnStats): Promise<void> {
  const session = basename(file).replace(/\.jsonl(?:\.zst)?$/, '');
  let cwd: string | null = null;
  const turn = new TurnTracker({ project: () => cwd ?? 'codex', session, agent: 'codex', sinceMs: opts.since ? opts.since.getTime() : 0 }, out, stats);
  let first = true;
  let sawTurnEvents = false;
  // Codex writes the same edit or command as a response_item and again as an item_completed (paginated mode) or a
  // patch_apply_end (legacy mode); ids are shared, so each is counted once.
  const seen = new Set<string>();
  for await (const line of await readLines(file)) {
    if (!line.startsWith('{')) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = ts(j.timestamp);
    const type = j.type;
    const payload = obj(j.payload) ?? {};
    if (first) {
      first = false;
      if (type === 'session_meta' && typeof payload.cwd === 'string') cwd = payload.cwd;
      if (type === 'session_meta') continue;
    }
    if (type === 'turn_context' && typeof payload.cwd === 'string') cwd = payload.cwd;
    if (type === 'event_msg') {
      const et = payload.type;
      if (et === 'turn_started') {
        sawTurnEvents = true;
        turn.finalize();
      } else if (et === 'turn_complete') {
        if (typeof payload.last_agent_message === 'string') turn.text(payload.last_agent_message, at);
        sawTurnEvents = true;
        turn.finalize();
      } else if (et === 'turn_aborted') {
        // Persisted on its own by 2025 builds that did not persist turn_started/turn_complete: it ends this turn but
        // says nothing about how the rest of the file delimits turns.
        if (typeof payload.last_agent_message === 'string') turn.text(payload.last_agent_message, at);
        turn.finalize();
      } else if (et === 'user_message' && !sawTurnEvents) {
        turn.finalize();
      } else if (et === 'agent_message' && typeof payload.message === 'string') {
        turn.text(payload.message, at);
      } else if (et === 'patch_apply_end') {
        const id = typeof payload.call_id === 'string' ? payload.call_id : '';
        if (!(id && seen.has(id)) && payload.success !== false) turn.edit(at);
        if (id) seen.add(id);
      } else if (et === 'item_completed') {
        const item = obj(payload.item) ?? {};
        const kind = item.type;
        const id = typeof item.id === 'string' ? item.id : '';
        if (kind === 'FileChange') {
          if (!(id && seen.has(id)) && item.status !== 'failed' && item.status !== 'declined') turn.edit(at);
          if (id) seen.add(id);
        } else if (kind === 'CommandExecution') {
          const cmd = Array.isArray(item.command) ? item.command.map(String).join(' ') : typeof item.command === 'string' ? item.command : '';
          const ok = typeof item.exit_code === 'number' ? item.exit_code === 0 : item.status === 'failed' ? false : null;
          // Declined at the approval prompt (or never finished): not a test run.
          const neverRan = ok === null && (item.status === 'declined' || item.status === 'in_progress');
          if (id && seen.has(id)) {
            // Already counted from the response_item; this copy may still settle a command that was left running.
            if (neverRan) turn.forget(id);
            else if (turn.isPending(id)) turn.resolve(id, ok, at);
          } else {
            if (id) seen.add(id);
            if (!neverRan) turn.ran(cmd, ok, at);
          }
        } else if (kind === 'AgentMessage') {
          const t = (Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
          if (t.trim()) turn.text(t, at);
        } else if (kind === 'UserMessage' && !sawTurnEvents) {
          turn.finalize();
        }
      }
      continue;
    }
    if (type !== 'response_item') continue;
    const pt = payload.type;
    if (pt === 'message') {
      const role = payload.role;
      const text = messageText(payload);
      if (role === 'user' && text !== null && !sawTurnEvents) turn.finalize();
      else if (role === 'assistant' && text !== null) turn.text(text, at);
    } else if (pt === 'function_call') {
      const id = typeof payload.call_id === 'string' ? payload.call_id : '';
      const cmd = commandOf(payload);
      const sid = stdinSession(payload);
      if (cmd !== null) {
        if (id) seen.add(id);
        turn.command(id, cmd, at);
      } else if (sid !== null && id) {
        // Polling a still-running command: its exit code will come back under this call id.
        turn.rekey(`session:${sid}`, id);
      }
    } else if (pt === 'local_shell_call') {
      const action = obj(payload.action) ?? {};
      const cmd = Array.isArray(action.command) ? action.command.map(String).join(' ') : '';
      const id = typeof payload.call_id === 'string' ? payload.call_id : '';
      if (cmd) {
        if (id) seen.add(id);
        turn.command(id, cmd, at);
      }
    } else if (pt === 'function_call_output') {
      const id = typeof payload.call_id === 'string' ? payload.call_id : '';
      const o = commandOutcome(payload.output);
      if (o.running !== null) turn.rekey(id, `session:${o.running}`);
      else if (o.rejected) turn.forget(id);
      else turn.resolve(id, o.ok, at);
    } else if (pt === 'custom_tool_call') {
      const id = typeof payload.call_id === 'string' ? payload.call_id : '';
      if (payload.name === 'apply_patch') {
        if (!(id && seen.has(id))) turn.edit(at);
        if (id) seen.add(id);
      }
    }
  }
  turn.finalize();
}
