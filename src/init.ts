import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { detectChecks } from './detect.js';
import { readJsonFile, stripBom } from './fsutil.js';
import { detectHosts, getHost, HOST_NAMES, type HostAdapter, type HostName } from './hosts.js';
import { RECEIPT_DIR } from './git.js';
import { budgetSeconds } from './verify.js';

export type HookEvent = 'stop' | 'edit';

export interface InitOptions {
  root: string;
  /** Hosts to install into. "auto" = every host with a settings dir in the repo (or in HOME when scope is user). */
  hosts: HostName[] | 'auto' | 'all';
  scope: 'project' | 'user';
  /** Stop-hook command; defaults to `npx -y <package> hook --host <name>`. The edit hook appends ` --event edit`. */
  command?: (host: HostAdapter) => string;
  /** Hook timeout in seconds. Default: enough for every detected check plus a margin, at least 600. */
  timeout?: number;
  remove?: boolean;
  /** Also install the warn-only post-edit hook where the host supports it. Default true. */
  editHook?: boolean;
}

export interface InitResult {
  host: HostName;
  displayName: string;
  event: HookEvent;
  /** Host's event name (Stop, PostToolUse, AfterAgent, ...). */
  hostEvent: string;
  path: string;
  scope: 'project' | 'user';
  action: 'added' | 'updated' | 'unchanged' | 'removed' | 'absent';
  command: string;
  timeout: number;
  note: string | null;
}

export interface InstalledHook {
  host: HostAdapter;
  event: HookEvent;
  scope: 'project' | 'user';
  path: string;
  command: string;
  timeout: number | null;
}

export const DEFAULT_HOOK_TIMEOUT_S = 600;
/** The edit hook only scans a diff; it must stay fast. */
export const EDIT_HOOK_TIMEOUT_S = 30;
/** Startup margin for npx resolution and git hashing, in seconds. */
const HOOK_MARGIN_S = 60;
export const PACKAGE_NAME = '@aivolution/isitdone';

export function defaultCommand(host: HostAdapter): string {
  return `npx -y ${PACKAGE_NAME} hook --host ${host.name}`;
}

export function editCommand(stopCommand: string): string {
  return `${stopCommand} --event edit`;
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (stripBom(text).trim() === '') return {};
  try {
    const v = readJsonFile<unknown>(path);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('top level is not an object');
    return v as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}); fix it or move it aside and re-run`);
  }
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  // No BOM: Codex rejects hooks.json with a BOM.
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8' });
}

/** Make sure `.isitdone/` is ignored by git, without rewriting an existing rule. */
export function ensureGitignore(root: string): 'added' | 'present' | 'skipped' {
  if (!existsSync(join(root, '.git'))) return 'skipped';
  const p = join(root, '.gitignore');
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === `${RECEIPT_DIR}/` || l === RECEIPT_DIR || l === `/${RECEIPT_DIR}` || l === `/${RECEIPT_DIR}/`)) return 'present';
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(p, `${existing}${sep}${RECEIPT_DIR}/\n`);
  return 'added';
}

/**
 * Which hosts to touch. "auto" looks at the project (.claude/, .codex/, .cursor/, .gemini/ in the repo), or at
 * HOME when --user was given; it never writes user-level files otherwise. With nothing detected it defaults to Claude Code.
 */
export function resolveHosts(root: string, hosts: InitOptions['hosts'], scope: 'project' | 'user'): Array<{ host: HostAdapter; scope: 'project' | 'user' }> {
  if (hosts === 'all') return HOST_NAMES.map((n) => ({ host: getHost(n), scope }));
  if (hosts === 'auto') {
    const found = detectHosts(root, existsSync)
      .filter((f) => f.scope === scope)
      .map((f) => ({ host: f.host, scope }));
    return found.length > 0 ? found : [{ host: getHost('claude'), scope }];
  }
  return hosts.map((n) => ({ host: getHost(n), scope }));
}

/** Hook timeout large enough for a full run of the detected checks. */
export function recommendedTimeout(root: string): number {
  try {
    const { config } = loadConfig(root);
    const d = detectChecks(root, config);
    return Math.max(DEFAULT_HOOK_TIMEOUT_S, Math.ceil(budgetSeconds(d.checks, config) + HOOK_MARGIN_S));
  } catch {
    return DEFAULT_HOOK_TIMEOUT_S;
  }
}

export function init(opts: InitOptions): InitResult[] {
  const results: InitResult[] = [];
  const timeout = Math.ceil(opts.timeout ?? recommendedTimeout(opts.root));
  if (!(timeout > 0)) throw new Error('timeout must be a positive number of seconds');
  const wantEdit = opts.editHook ?? true;

  if (opts.remove) {
    // Remove from every scope where our hooks are installed, unless hosts were named explicitly.
    const targets = installedHooks(opts.root).filter((h) => opts.hosts === 'auto' || opts.hosts === 'all' || (opts.hosts as HostName[]).includes(h.host.name));
    if (targets.length === 0) {
      for (const { host, scope } of resolveHosts(opts.root, opts.hosts, opts.scope)) {
        results.push({ host: host.name, displayName: host.displayName, event: 'stop', hostEvent: host.event, path: host.settingsPath(opts.root, scope), scope, action: 'absent', command: '', timeout, note: null });
      }
      return results;
    }
    const seen = new Set<string>();
    for (const t of targets) {
      const key = `${t.host.name}:${t.scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const settings = readSettings(t.path);
      const stopBefore = t.host.registered(settings);
      const editBefore = t.host.edit?.registered(settings) ?? null;
      const changedStop = t.host.unregister(settings);
      const changedEdit = t.host.edit ? t.host.edit.unregister(settings) : false;
      if (changedStop || changedEdit) writeSettings(t.path, settings);
      results.push({ host: t.host.name, displayName: t.host.displayName, event: 'stop', hostEvent: t.host.event, path: t.path, scope: t.scope, action: changedStop ? 'removed' : 'absent', command: stopBefore ?? '', timeout, note: null });
      if (t.host.edit && editBefore) results.push({ host: t.host.name, displayName: t.host.displayName, event: 'edit', hostEvent: t.host.edit.event, path: t.path, scope: t.scope, action: changedEdit ? 'removed' : 'absent', command: editBefore, timeout: EDIT_HOOK_TIMEOUT_S, note: null });
    }
    return results;
  }

  for (const { host, scope } of resolveHosts(opts.root, opts.hosts, opts.scope)) {
    const path = host.settingsPath(opts.root, scope);
    const command = (opts.command ?? defaultCommand)(host);
    const settings = readSettings(path);
    const stopBefore = host.registered(settings);
    const changedStop = host.register(settings, command, timeout);
    let changedEdit = false;
    let editBefore: string | null = null;
    if (wantEdit && host.edit) {
      editBefore = host.edit.registered(settings);
      changedEdit = host.edit.register(settings, editCommand(command), EDIT_HOOK_TIMEOUT_S);
    }
    if (changedStop || changedEdit) writeSettings(path, settings);
    results.push({
      host: host.name,
      displayName: host.displayName,
      event: 'stop',
      hostEvent: host.event,
      path,
      scope,
      action: !changedStop ? 'unchanged' : stopBefore ? 'updated' : 'added',
      command,
      timeout,
      note: host.postInstallNote,
    });
    if (wantEdit && host.edit) {
      results.push({
        host: host.name,
        displayName: host.displayName,
        event: 'edit',
        hostEvent: host.edit.event,
        path,
        scope,
        action: !changedEdit ? 'unchanged' : editBefore ? 'updated' : 'added',
        command: editCommand(command),
        timeout: EDIT_HOOK_TIMEOUT_S,
        note: null,
      });
    }
  }
  return results;
}

/** Which hosts currently have isitdone hooks, checking project then user scope. */
export function installedHooks(root: string): InstalledHook[] {
  const out: InstalledHook[] = [];
  for (const name of HOST_NAMES) {
    const host = getHost(name);
    for (const scope of ['project', 'user'] as const) {
      const path = host.settingsPath(root, scope);
      if (!existsSync(path)) continue;
      let settings: Record<string, unknown>;
      try {
        settings = readSettings(path);
      } catch {
        continue;
      }
      const stop = host.registered(settings);
      if (stop) out.push({ host, event: 'stop', scope, path, command: stop, timeout: registeredTimeout(settings, stop, host) });
      const edit = host.edit?.registered(settings) ?? null;
      if (edit) out.push({ host, event: 'edit', scope, path, command: edit, timeout: registeredTimeout(settings, edit, host) });
    }
  }
  return out;
}

function registeredTimeout(settings: Record<string, unknown>, command: string, host: HostAdapter): number | null {
  const text = JSON.stringify(settings);
  const idx = text.indexOf(JSON.stringify(command));
  if (idx < 0) return null;
  const m = /"timeout"\s*:\s*(\d+(?:\.\d+)?)/.exec(text.slice(idx, idx + 400));
  if (!m) return null;
  const n = Number(m[1]);
  return host.name === 'gemini' ? n / 1000 : n;
}
