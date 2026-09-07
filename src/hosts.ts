/**
 * Host adapters: how each coding agent registers a Stop hook (and a warn-only post-edit hook), what it sends on
 * stdin, and how it expects "block" / "allow" / "warn" to be expressed.
 *
 * Verified against the vendor docs on 2026-09-07:
 *  - Claude Code: https://code.claude.com/docs/en/hooks
 *  - Codex CLI:   https://learn.chatgpt.com/docs/hooks
 *  - Cursor:      https://cursor.com/docs/hooks
 *  - Gemini CLI:  https://geminicli.com/docs/hooks/reference/
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type HostName = 'claude' | 'codex' | 'cursor' | 'gemini';

export const HOST_NAMES: HostName[] = ['claude', 'codex', 'cursor', 'gemini'];

/** Normalised view of a Stop-style hook payload. */
export interface HookInput {
  sessionId: string | null;
  /** Host's turn/prompt id when it provides one (diagnostics only; semantics differ per host). */
  turnId: string | null;
  /** Directory the host reports; may be a subdirectory of the repo. */
  cwd: string | null;
  /** The agent's final message for this turn, when the host provides it. */
  lastMessage: string | null;
  /** True when the host is already continuing because a stop hook blocked. */
  stopHookActive: boolean;
  /** Cursor: how many automatic follow-ups this conversation has had (any hook). */
  loopCount: number | null;
  /** Cursor: completed | aborted | error. */
  status: string | null;
  /** Claude Code: number of background tasks still running. */
  backgroundTasks: number;
  /** Claude Code / Codex permission mode (plan mode cannot edit files). */
  permissionMode: string | null;
  hookEventName: string | null;
}

/** Normalised view of a post-edit hook payload. */
export interface EditInput {
  /** Files the tool touched (absolute or relative to cwd). */
  files: string[];
  cwd: string | null;
  toolName: string | null;
}

/** Warn-only hook after the agent edits a file. Null when the host has no channel the agent can see. */
export interface EditSupport {
  event: string;
  matcher: string;
  register(settings: Record<string, unknown>, command: string, timeoutSeconds: number): boolean;
  registered(settings: Record<string, unknown>): string | null;
  unregister(settings: Record<string, unknown>): boolean;
  parse(raw: Record<string, unknown>): EditInput;
  /** stdout that adds `text` to the agent's context without blocking. */
  warn(text: string): string;
  /** stdout that says nothing. */
  silent(): string;
  synthetic(root: string, file: string): Record<string, unknown>;
}

export interface HostAdapter {
  name: HostName;
  displayName: string;
  /** Hook event name as the host spells it. */
  event: string;
  /** Path to the settings file that holds hooks (project-level or user-level). */
  settingsPath(root: string, scope: 'project' | 'user'): string;
  /** Normalise the raw payload. */
  parse(raw: Record<string, unknown>): HookInput;
  /** stdout text that lets the agent stop. */
  allow(systemMessage?: string): string;
  /** stdout text that blocks the stop and feeds `reason` back to the agent. */
  block(reason: string): string;
  /** Add the hook to a settings object (idempotent). Returns true if changed. */
  register(settings: Record<string, unknown>, command: string, timeoutSeconds: number): boolean;
  /** Is an isitdone hook already present? */
  registered(settings: Record<string, unknown>): string | null;
  /** Remove any isitdone hook. Returns true if changed. */
  unregister(settings: Record<string, unknown>): boolean;
  /** What the user must do after registration, if anything. */
  postInstallNote: string | null;
  /** Build a realistic synthetic payload for doctor. */
  synthetic(root: string, message: string): Record<string, unknown>;
  edit: EditSupport | null;
}

/** Recognise our own hook command whether it is `npx isitdone hook`, `node .../isitdone.js hook`, or a custom wrapper. */
export const HOOK_MARKER = /\bisitdone\b[^\n]*\bhook\b/;

export function isOurCommand(v: unknown): v is string {
  return typeof v === 'string' && HOOK_MARKER.test(v);
}

/** Is this one of our commands for the edit event (vs the stop event)? */
export function isEditCommand(v: unknown): boolean {
  return isOurCommand(v) && /--event[=\s]+edit\b/.test(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pick the workspace root that contains the process cwd (Cursor runs project hooks from the project root). */
function pickRoot(roots: unknown[]): string | null {
  const list = roots.filter((r): r is string => typeof r === 'string' && r !== '');
  if (list.length === 0) return null;
  if (list.length === 1) return list[0] as string;
  const cwd = resolve(process.cwd()).toLowerCase();
  const inside = list.find((r) => {
    const rr = resolve(r).toLowerCase();
    return cwd === rr || cwd.startsWith(rr.endsWith('\\') || rr.endsWith('/') ? rr : rr + (process.platform === 'win32' ? '\\' : '/'));
  });
  return inside ?? (list[0] as string);
}

/** Files named in a Codex apply_patch document. */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\s*\*\*\* (?:Update File|Add File|Delete File|Move to): (.+?)\s*$/gm)) out.push(m[1] as string);
  return [...new Set(out)];
}

/** Claude Code / Codex / Gemini share the `hooks.<Event>[].hooks[]` shape. */
function registerClaudeStyle(settings: Record<string, unknown>, event: string, command: string, timeout: number, opts: { matcher?: string; extra?: Record<string, unknown>; isMine: (v: unknown) => boolean }): boolean {
  const hooks = (settings.hooks = obj(settings.hooks) ?? {});
  const groups = (hooks[event] = arr(hooks[event]));
  for (const g of groups) {
    const go = obj(g);
    if (!go) continue;
    for (const h of arr(go.hooks)) {
      const ho = obj(h);
      if (ho && opts.isMine(ho.command)) {
        if (ho.command === command && ho.timeout === timeout && (opts.matcher === undefined || go.matcher === opts.matcher)) return false;
        ho.command = command;
        ho.timeout = timeout;
        if (opts.matcher !== undefined) go.matcher = opts.matcher;
        return true;
      }
    }
  }
  groups.push({ ...(opts.matcher !== undefined ? { matcher: opts.matcher } : {}), hooks: [{ type: 'command', command, timeout, ...(opts.extra ?? {}) }] });
  return true;
}

function registeredClaudeStyle(settings: Record<string, unknown>, event: string, isMine: (v: unknown) => boolean): string | null {
  for (const g of arr(obj(settings.hooks)?.[event])) {
    for (const h of arr(obj(g)?.hooks)) {
      const cmd = obj(h)?.command;
      if (isMine(cmd)) return cmd as string;
    }
  }
  return null;
}

function unregisterClaudeStyle(settings: Record<string, unknown>, event: string, isMine: (v: unknown) => boolean): boolean {
  const hooks = obj(settings.hooks);
  if (!hooks) return false;
  const groups = arr(hooks[event]);
  let changed = false;
  const kept = groups.filter((g) => {
    const go = obj(g);
    if (!go) return true;
    const before = arr(go.hooks).length;
    go.hooks = arr(go.hooks).filter((h) => !isMine(obj(h)?.command));
    if ((go.hooks as unknown[]).length !== before) changed = true;
    return (go.hooks as unknown[]).length > 0;
  });
  if (kept.length !== groups.length) changed = true;
  if (kept.length === 0) delete hooks[event];
  else hooks[event] = kept;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return changed;
}

const isStop = (v: unknown) => isOurCommand(v) && !isEditCommand(v);

function additionalContext(eventName: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}

function editFiles(raw: Record<string, unknown>): string[] {
  const input = obj(raw.tool_input) ?? {};
  const files: string[] = [];
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = str(input[k]);
    if (v) files.push(v);
  }
  if (typeof input.command === 'string' && /\*\*\* (?:Begin Patch|Update File|Add File)/.test(input.command)) files.push(...patchPaths(input.command));
  for (const e of arr(input.edits)) {
    const p = str(obj(e)?.file_path);
    if (p) files.push(p);
  }
  return [...new Set(files)];
}

const claude: HostAdapter = {
  name: 'claude',
  displayName: 'Claude Code',
  event: 'Stop',
  settingsPath: (root, scope) => (scope === 'project' ? join(root, '.claude', 'settings.json') : join(homedir(), '.claude', 'settings.json')),
  // Also tolerates Cursor-shaped payloads: Cursor can run .claude/settings.json hooks when third-party configs are enabled.
  parse: (raw) => ({
    sessionId: str(raw.session_id) ?? str(raw.conversation_id),
    turnId: str(raw.prompt_id) ?? str(raw.generation_id),
    cwd: str(raw.cwd) ?? pickRoot(arr(raw.workspace_roots)),
    lastMessage: str(raw.last_assistant_message),
    stopHookActive: raw.stop_hook_active === true,
    loopCount: num(raw.loop_count),
    status: str(raw.status),
    backgroundTasks: arr(raw.background_tasks).length,
    permissionMode: str(raw.permission_mode),
    hookEventName: str(raw.hook_event_name),
  }),
  allow: (systemMessage) => (systemMessage ? JSON.stringify({ systemMessage }) : ''),
  block: (reason) => JSON.stringify({ decision: 'block', reason }),
  register: (s, command, timeout) => registerClaudeStyle(s, 'Stop', command, timeout, { isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, 'Stop', isStop),
  unregister: (s) => unregisterClaudeStyle(s, 'Stop', isStop),
  postInstallNote: 'Claude Code reloads settings automatically; if the hook does not show in /hooks within a few seconds, restart the session.',
  synthetic: (root, message) => ({
    session_id: 'isitdone-doctor',
    transcript_path: join(root, '.isitdone', 'doctor-transcript.jsonl'),
    cwd: root,
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: message,
    background_tasks: [],
  }),
  edit: {
    event: 'PostToolUse',
    matcher: 'Edit|Write|MultiEdit',
    register: (s, command, timeout) => registerClaudeStyle(s, 'PostToolUse', command, timeout, { matcher: 'Edit|Write|MultiEdit', isMine: isEditCommand }),
    registered: (s) => registeredClaudeStyle(s, 'PostToolUse', isEditCommand),
    unregister: (s) => unregisterClaudeStyle(s, 'PostToolUse', isEditCommand),
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd) ?? pickRoot(arr(raw.workspace_roots)), toolName: str(raw.tool_name) }),
    warn: (text) => additionalContext('PostToolUse', text),
    silent: () => '',
    synthetic: (root, file) => ({ session_id: 'isitdone-doctor', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, file), old_string: 'a', new_string: 'b' }, tool_response: { filePath: join(root, file), success: true }, tool_use_id: 'doctor' }),
  },
};

const codex: HostAdapter = {
  name: 'codex',
  displayName: 'Codex CLI',
  event: 'Stop',
  settingsPath: (root, scope) => (scope === 'project' ? join(root, '.codex', 'hooks.json') : join(homedir(), '.codex', 'hooks.json')),
  parse: (raw) => ({
    sessionId: str(raw.session_id),
    turnId: str(raw.turn_id),
    cwd: str(raw.cwd),
    lastMessage: str(raw.last_assistant_message),
    stopHookActive: raw.stop_hook_active === true,
    loopCount: null,
    status: null,
    backgroundTasks: 0,
    permissionMode: str(raw.permission_mode),
    hookEventName: str(raw.hook_event_name),
  }),
  // Codex validates output strictly (no extra keys) and prefers empty stdout for "allow".
  allow: (systemMessage) => (systemMessage ? JSON.stringify({ systemMessage }) : ''),
  block: (reason) => JSON.stringify({ decision: 'block', reason }),
  register: (s, command, timeout) => registerClaudeStyle(s, 'Stop', command, timeout, { isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, 'Stop', isStop),
  unregister: (s) => unregisterClaudeStyle(s, 'Stop', isStop),
  postInstallNote: 'Codex requires you to trust new hooks: open Codex in this repo and run /hooks, then trust the isitdone entries. Re-trust after any change to the commands.',
  synthetic: (root, message) => ({
    session_id: 'isitdone-doctor',
    turn_id: 'turn-1',
    transcript_path: null,
    cwd: root,
    hook_event_name: 'Stop',
    model: 'doctor',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: message,
  }),
  edit: {
    event: 'PostToolUse',
    matcher: 'Edit|Write',
    register: (s, command, timeout) => registerClaudeStyle(s, 'PostToolUse', command, timeout, { matcher: 'Edit|Write', isMine: isEditCommand }),
    registered: (s) => registeredClaudeStyle(s, 'PostToolUse', isEditCommand),
    unregister: (s) => unregisterClaudeStyle(s, 'PostToolUse', isEditCommand),
    // apply_patch reports tool_input.command = the patch text; file names come from its *** headers.
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd), toolName: str(raw.tool_name) }),
    warn: (text) => additionalContext('PostToolUse', text),
    silent: () => '',
    synthetic: (root, file) => ({ session_id: 'isitdone-doctor', turn_id: 'turn-1', transcript_path: null, cwd: root, hook_event_name: 'PostToolUse', model: 'doctor', permission_mode: 'default', tool_name: 'apply_patch', tool_use_id: 'doctor', tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n` }, tool_response: `Success. Updated the following files:\nM ${file}\n` }),
  },
};

const cursor: HostAdapter = {
  name: 'cursor',
  displayName: 'Cursor',
  event: 'stop',
  settingsPath: (root, scope) => (scope === 'project' ? join(root, '.cursor', 'hooks.json') : join(homedir(), '.cursor', 'hooks.json')),
  parse: (raw) => ({
    sessionId: str(raw.conversation_id),
    turnId: str(raw.generation_id),
    cwd: pickRoot(arr(raw.workspace_roots)) ?? str(raw.cwd),
    lastMessage: str(raw.last_assistant_message) ?? str(raw.text),
    // Cursor has no per-turn flag; loop_count is per conversation. hook.ts derives continuation from its delta.
    stopHookActive: false,
    loopCount: num(raw.loop_count),
    status: str(raw.status),
    backgroundTasks: 0,
    permissionMode: null,
    hookEventName: str(raw.hook_event_name),
  }),
  allow: () => '{}',
  block: (reason) => JSON.stringify({ followup_message: reason }),
  register: (s, command, timeout) => {
    if (s.version === undefined) s.version = 1;
    const hooks = (s.hooks = obj(s.hooks) ?? {});
    const list = (hooks.stop = arr(hooks.stop));
    for (const h of list) {
      const ho = obj(h);
      if (ho && isStop(ho.command)) {
        if (ho.command === command && ho.timeout === timeout) return false;
        ho.command = command;
        ho.timeout = timeout;
        return true;
      }
    }
    // loop_limit is per conversation in Cursor, so a small value would silently disable the gate later in a long
    // session. isitdone enforces its own per-turn attempts cap instead.
    list.push({ command, timeout, loop_limit: null });
    return true;
  },
  registered: (s) => {
    for (const h of arr(obj(s.hooks)?.stop)) {
      const cmd = obj(h)?.command;
      if (isStop(cmd)) return cmd as string;
    }
    return null;
  },
  unregister: (s) => {
    const hooks = obj(s.hooks);
    if (!hooks) return false;
    const list = arr(hooks.stop);
    const kept = list.filter((h) => !isStop(obj(h)?.command));
    if (kept.length === list.length) return false;
    if (kept.length === 0) delete hooks.stop;
    else hooks.stop = kept;
    return true;
  },
  postInstallNote:
    'Cursor runs project hooks only in trusted workspaces; check the Hooks tab under Customize. Cursor does not pass the final message to stop hooks, so isitdone runs the full profile there (cached per tree), and it has no agent-visible channel after a file edit, so the test-integrity warnings arrive with the Stop hook. If "Include third-party Plugins, Skills, and other configs" is enabled, Cursor also runs hooks from .claude/settings.json: keep only one registration to avoid running the checks twice.',
  synthetic: (root, message) => ({
    conversation_id: 'isitdone-doctor',
    generation_id: 'gen-1',
    model: 'doctor',
    hook_event_name: 'stop',
    cursor_version: '0',
    workspace_roots: [root],
    user_email: null,
    transcript_path: null,
    status: 'completed',
    loop_count: 0,
    last_assistant_message: message,
  }),
  edit: null,
};

const gemini: HostAdapter = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  event: 'AfterAgent',
  settingsPath: (root, scope) => (scope === 'project' ? join(root, '.gemini', 'settings.json') : join(homedir(), '.gemini', 'settings.json')),
  parse: (raw) => ({
    sessionId: str(raw.session_id),
    turnId: null,
    cwd: str(raw.cwd),
    lastMessage: str(raw.prompt_response) === '[no response text]' ? null : str(raw.prompt_response),
    stopHookActive: raw.stop_hook_active === true,
    loopCount: null,
    status: null,
    backgroundTasks: 0,
    permissionMode: null,
    hookEventName: str(raw.hook_event_name),
  }),
  allow: (systemMessage) => JSON.stringify(systemMessage ? { decision: 'allow', systemMessage } : {}),
  block: (reason) => JSON.stringify({ decision: 'deny', reason }),
  // Gemini timeouts are milliseconds.
  register: (s, command, timeout) => registerClaudeStyle(s, 'AfterAgent', command, timeout * 1000, { matcher: '*', extra: { name: 'isitdone' }, isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, 'AfterAgent', isStop),
  unregister: (s) => unregisterClaudeStyle(s, 'AfterAgent', isStop),
  postInstallNote: 'Gemini CLI prints a warning the first time it sees a project hook, then runs it. The folder must be trusted. Use /hooks panel to inspect.',
  synthetic: (root, message) => ({
    session_id: 'isitdone-doctor',
    transcript_path: join(root, '.isitdone', 'doctor-transcript.json'),
    cwd: root,
    hook_event_name: 'AfterAgent',
    timestamp: new Date().toISOString(),
    prompt: 'doctor',
    prompt_response: message,
    stop_hook_active: false,
  }),
  edit: {
    event: 'AfterTool',
    matcher: 'write_file|replace',
    register: (s, command, timeout) => registerClaudeStyle(s, 'AfterTool', command, timeout * 1000, { matcher: 'write_file|replace', extra: { name: 'isitdone-edit' }, isMine: isEditCommand }),
    registered: (s) => registeredClaudeStyle(s, 'AfterTool', isEditCommand),
    unregister: (s) => unregisterClaudeStyle(s, 'AfterTool', isEditCommand),
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd), toolName: str(raw.tool_name) }),
    warn: (text) => additionalContext('AfterTool', text),
    silent: () => '{}',
    synthetic: (root, file) => ({ session_id: 'isitdone-doctor', cwd: root, hook_event_name: 'AfterTool', timestamp: new Date().toISOString(), tool_name: 'replace', tool_input: { file_path: join(root, file), old_string: 'a', new_string: 'b' }, tool_response: { llmContent: 'Successfully modified file', returnDisplay: {} } }),
  },
};

export const HOSTS: Record<HostName, HostAdapter> = { claude, codex, cursor, gemini };

export function getHost(name: string): HostAdapter {
  const h = (HOSTS as Record<string, HostAdapter>)[name];
  if (!h) throw new Error(`unknown host "${name}" (expected one of ${HOST_NAMES.join(', ')})`);
  return h;
}

/** Hosts whose settings dir exists in this repo (project) or the home directory (user), in a stable order. */
export function detectHosts(root: string, exists: (p: string) => boolean): Array<{ host: HostAdapter; scope: 'project' | 'user'; path: string }> {
  const found: Array<{ host: HostAdapter; scope: 'project' | 'user'; path: string }> = [];
  const dirs: Record<HostName, string> = { claude: '.claude', codex: '.codex', cursor: '.cursor', gemini: '.gemini' };
  for (const name of HOST_NAMES) {
    const host = HOSTS[name];
    if (exists(join(root, dirs[name]))) found.push({ host, scope: 'project', path: host.settingsPath(root, 'project') });
    if (exists(join(homedir(), dirs[name]))) found.push({ host, scope: 'user', path: host.settingsPath(root, 'user') });
  }
  return found;
}
