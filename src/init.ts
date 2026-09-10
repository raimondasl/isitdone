import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadConfig } from './config.js';
import { detectChecks } from './detect.js';
import { readJsonFile, stripBom } from './fsutil.js';
import { detectHosts, getHost, HOST_NAMES, hostScopes, type HookScope, type HostAdapter, type HostName } from './hosts.js';
import { RECEIPT_DIR } from './git.js';
import { budgetSeconds } from './verify.js';

export type HookEvent = 'stop' | 'edit';

export interface InitOptions {
  root: string;
  /** Hosts to install into. "auto" = every host with a settings dir in the repo (or in HOME when scope is user). */
  hosts: HostName[] | 'auto' | 'all';
  scope: HookScope;
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
  scope: HookScope;
  /** "skipped": nothing written, `note` says why (scope not supported, or another host's registration already covers it). */
  action: 'added' | 'updated' | 'unchanged' | 'removed' | 'absent' | 'skipped';
  command: string;
  timeout: number;
  note: string | null;
}

export interface InstalledHook {
  host: HostAdapter;
  event: HookEvent;
  scope: HookScope;
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

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
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

export interface HostTarget {
  host: HostAdapter;
  scope: HookScope;
  /** Set when the host cannot be installed in this scope; init reports it as "skipped" with this note. */
  skip?: string;
}

/**
 * Which hosts to touch. "auto" looks at the project (the host's settings dir in the repo), or at HOME when --user was
 * given; it never writes user-level files otherwise. With nothing detected it defaults to Claude Code. "all" names every
 * host; ones that do not read hooks from the requested scope (Junie: user only) come back marked `skip`, while naming
 * such a host explicitly is an error.
 */
export function resolveHosts(root: string, hosts: InitOptions['hosts'], scope: HookScope): HostTarget[] {
  const supported = (h: HostAdapter) => hostScopes(h).includes(scope);
  const scopeNote = (h: HostAdapter) => `${h.displayName} reads hooks only from ${h.settingsPath(root, scope === 'project' ? 'user' : 'project')}; re-run ${scope === 'project' ? 'with --user' : 'without --user'}`;
  if (hosts === 'all') return HOST_NAMES.map((n) => getHost(n)).map((host) => (supported(host) ? { host, scope } : { host, scope, skip: scopeNote(host) }));
  if (hosts === 'auto') {
    const found = detectHosts(root, existsSync)
      .filter((f) => f.scope === scope)
      .map((f) => ({ host: f.host, scope }));
    return found.length > 0 ? found : [{ host: getHost('claude'), scope }];
  }
  return hosts.map((n) => {
    const host = getHost(n);
    if (!supported(host)) throw new Error(scopeNote(host));
    return { host, scope };
  });
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

/** A note when another host's registration in the same scope already drives this host (Devin loads .claude/settings.json). */
function coveredBy(host: HostAdapter, root: string, scope: HookScope): string | null {
  if (!host.coveredBy) return null;
  const other = getHost(host.coveredBy);
  const otherPath = other.settingsPath(root, scope);
  if (!existsSync(otherPath)) return null;
  let cmd: string | null;
  try {
    cmd = other.registered(readSettings(otherPath), scope);
  } catch {
    return null;
  }
  if (!cmd) return null;
  return `${host.displayName} also loads ${otherPath}, which already runs "${cmd}"; a second registration would run the checks twice. Uninstall the ${other.displayName} hook first if you want a native ${host.displayName} entry.`;
}

/** Hosts whose settings file is entirely ours and harmful when left empty (Droid: an empty hooks.json keeps masking settings.json; Copilot: schema-invalid). */
const DELETE_WHEN_EMPTY = new Set<HostName>(['copilot', 'droid']);

const WRAPPER_MARK = 'isitdone wrapper';

/** For a `scriptOnly` host: write isitdone-hook.sh / .cmd next to the settings file and return the path to register. */
function wrapperCommand(host: HostAdapter, root: string, scope: HookScope, command: string): string {
  const dir = join(dirname(host.settingsPath(root, scope)), 'hooks');
  mkdirSync(dir, { recursive: true });
  const sh = join(dir, 'isitdone-hook.sh');
  const cmd = join(dir, 'isitdone-hook.cmd');
  writeFileSync(sh, `#!/bin/sh\n# ${WRAPPER_MARK}: ${host.displayName} runs script files, not command lines\nexec ${command} "$@"\n`, { encoding: 'utf8', mode: 0o755 });
  try {
    chmodSync(sh, 0o755);
  } catch {
    // Windows
  }
  writeFileSync(cmd, `@echo off\r\nrem ${WRAPPER_MARK}: ${host.displayName} runs script files, not command lines\r\n${command} %*\r\n`, 'utf8');
  const chosen = process.platform === 'win32' ? cmd : sh;
  // A project entry is relative to the repo; cmd.exe cannot run a forward-slash path in the command position, so the
  // Windows entry keeps backslashes (the file is per-platform anyway: .cmd on Windows, .sh elsewhere).
  return scope === 'project' ? relative(root, chosen) : chosen;
}

function removeWrappers(settingsPath: string): void {
  for (const name of ['isitdone-hook.sh', 'isitdone-hook.cmd']) {
    const p = join(dirname(settingsPath), 'hooks', name);
    try {
      if (existsSync(p) && readFileSync(p, 'utf8').includes(WRAPPER_MARK)) rmSync(p, { force: true });
    } catch {
      // leave it
    }
  }
}

/** Is our stop hook already in this file? (An installed Devin entry must not be reported "skipped" because Claude is installed too.) */
function alreadyRegistered(host: HostAdapter, path: string, scope: HookScope): boolean {
  if (host.kind !== 'json' || !existsSync(path)) return false;
  try {
    return host.registered(readSettings(path), scope) !== null;
  } catch {
    return false;
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
      // Nothing to remove: report "absent" for the named hosts without insisting on the scope (uninstall --agent junie).
      const named = opts.hosts === 'all' || opts.hosts === 'auto' ? resolveHosts(opts.root, opts.hosts, opts.scope) : (opts.hosts as HostName[]).map((n) => {
        const host = getHost(n);
        const scopes = hostScopes(host);
        return { host, scope: scopes.includes(opts.scope) ? opts.scope : (scopes[0] as HookScope) };
      });
      for (const { host, scope } of named) {
        results.push({ host: host.name, displayName: host.displayName, event: 'stop', hostEvent: host.event, path: host.settingsPath(opts.root, scope), scope, action: 'absent', command: '', timeout, note: null });
      }
      return results;
    }
    const seen = new Set<string>();
    for (const t of targets) {
      const key = `${t.host.name}:${t.scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = { host: t.host.name, displayName: t.host.displayName, path: t.path, scope: t.scope, timeout, note: null };
      if (t.host.kind === 'file' && t.host.file) {
        // The whole file is ours: delete it (installedHooks only lists files that carry our marker).
        const text = readText(t.path);
        const parsed = text === null ? null : t.host.file.parse(text);
        if (parsed) rmSync(t.path, { force: true });
        results.push({ ...base, event: 'stop', hostEvent: t.host.event, action: parsed ? 'removed' : 'absent', command: parsed?.stopCommand ?? '' });
        if (t.host.edit && parsed?.editCommand) results.push({ ...base, event: 'edit', hostEvent: t.host.edit.event, action: 'removed', command: parsed.editCommand, timeout: EDIT_HOOK_TIMEOUT_S });
        continue;
      }
      const settings = readSettings(t.path);
      const stopBefore = t.host.registered(settings, t.scope);
      const editBefore = t.host.edit?.registered(settings, t.scope) ?? null;
      const changedStop = t.host.unregister(settings, t.scope);
      const changedEdit = t.host.edit ? t.host.edit.unregister(settings, t.scope) : false;
      if (changedStop || changedEdit) {
        const leftover = Object.keys(settings).filter((k) => !(k === 'version' && Object.keys(settings).length === 1));
        if (leftover.length === 0 && DELETE_WHEN_EMPTY.has(t.host.name)) rmSync(t.path, { force: true });
        else writeSettings(t.path, settings);
      }
      if (t.host.scriptOnly) removeWrappers(t.path);
      results.push({ ...base, event: 'stop', hostEvent: t.host.event, action: changedStop ? 'removed' : 'absent', command: stopBefore ?? '' });
      if (t.host.edit && editBefore) results.push({ ...base, event: 'edit', hostEvent: t.host.edit.event, action: changedEdit ? 'removed' : 'absent', command: editBefore, timeout: EDIT_HOOK_TIMEOUT_S });
    }
    return results;
  }

  for (const { host, scope, skip } of resolveHosts(opts.root, opts.hosts, opts.scope)) {
    const path = host.settingsPath(opts.root, scope);
    const command = (opts.command ?? defaultCommand)(host);
    const base = { host: host.name, displayName: host.displayName, path, scope, timeout };
    // Augment runs script files: register a wrapper path, keep `command` for the doctor hint and the edit variant.
    const registerCommand = host.scriptOnly ? wrapperCommand(host, opts.root, scope, command) : command;
    const skipped = skip ?? (alreadyRegistered(host, path, scope) ? null : coveredBy(host, opts.root, scope));
    if (skipped) {
      results.push({ ...base, event: 'stop', hostEvent: host.event, action: 'skipped', command, note: skipped });
      continue;
    }
    if (host.kind === 'file' && host.file) {
      const before = readText(path);
      const prev = before === null ? null : host.file.parse(before);
      if (before !== null && prev === null) {
        // A foreign file is left alone and reported; the other hosts of --agent all still get installed.
        results.push({ ...base, event: 'stop', hostEvent: host.event, action: 'skipped', command, note: `${path} exists but was not generated by isitdone; move it aside and re-run` });
        continue;
      }
      // --no-edit-hook leaves an existing edit hook alone but does not add one.
      const edit = host.edit && (wantEdit || prev?.editCommand) ? editCommand(command) : null;
      const rendered = host.file.render(command, edit, timeout, EDIT_HOOK_TIMEOUT_S);
      const changed = before !== rendered;
      if (changed) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, rendered, { encoding: 'utf8' });
      }
      results.push({ ...base, event: 'stop', hostEvent: host.event, action: !changed ? 'unchanged' : prev?.stopCommand ? 'updated' : 'added', command, note: host.postInstallNote });
      if (edit && host.edit) results.push({ ...base, event: 'edit', hostEvent: host.edit.event, action: !changed ? 'unchanged' : prev?.editCommand ? 'updated' : 'added', command: edit, timeout: EDIT_HOOK_TIMEOUT_S, note: null });
      continue;
    }
    const settings = readSettings(path);
    const stopBefore = host.registered(settings, scope);
    const changedStop = host.register(settings, registerCommand, timeout, scope);
    let changedEdit = false;
    let editBefore: string | null = null;
    if (wantEdit && host.edit) {
      editBefore = host.edit.registered(settings, scope);
      changedEdit = host.edit.register(settings, editCommand(command), EDIT_HOOK_TIMEOUT_S, scope);
    }
    if (changedStop || changedEdit) writeSettings(path, settings);
    // Devin loads the Claude Code file too: a native Devin entry next to it would run the checks twice.
    const devinNote = host.name === 'claude' && alreadyRegistered(getHost('devin'), getHost('devin').settingsPath(opts.root, scope), scope) ? ` ${getHost('devin').settingsPath(opts.root, scope)} also registers isitdone natively; Devin loads both, so uninstall one of them (npx isitdone uninstall --agent devin).` : '';
    results.push({ ...base, event: 'stop', hostEvent: host.event, action: !changedStop ? 'unchanged' : stopBefore ? 'updated' : 'added', command: registerCommand, note: devinNote ? (host.postInstallNote ?? '') + devinNote : host.postInstallNote });
    if (wantEdit && host.edit) {
      results.push({ ...base, event: 'edit', hostEvent: host.edit.event, action: !changedEdit ? 'unchanged' : editBefore ? 'updated' : 'added', command: editCommand(command), timeout: EDIT_HOOK_TIMEOUT_S, note: null });
    }
  }
  return results;
}

/** Which hosts currently have isitdone hooks, checking project then user scope. */
export function installedHooks(root: string): InstalledHook[] {
  const out: InstalledHook[] = [];
  for (const name of HOST_NAMES) {
    const host = getHost(name);
    for (const scope of hostScopes(host)) {
      const path = host.settingsPath(root, scope);
      if (!existsSync(path)) continue;
      if (host.kind === 'file' && host.file) {
        const p = host.file.parse(readText(path) ?? '');
        if (!p?.stopCommand) continue;
        out.push({ host, event: 'stop', scope, path, command: p.stopCommand, timeout: p.timeoutSeconds });
        if (host.edit && p.editCommand) out.push({ host, event: 'edit', scope, path, command: p.editCommand, timeout: EDIT_HOOK_TIMEOUT_S });
        continue;
      }
      let settings: Record<string, unknown>;
      try {
        settings = readSettings(path);
      } catch {
        continue;
      }
      const stop = host.registered(settings, scope);
      if (stop) out.push({ host, event: 'stop', scope, path, command: stop, timeout: registeredTimeout(settings, stop, host) });
      const edit = host.edit?.registered(settings, scope) ?? null;
      if (edit) out.push({ host, event: 'edit', scope, path, command: edit, timeout: registeredTimeout(settings, edit, host) });
    }
  }
  return out;
}

function registeredTimeout(settings: Record<string, unknown>, command: string, host: HostAdapter): number | null {
  const text = JSON.stringify(settings);
  const idx = text.indexOf(JSON.stringify(command));
  if (idx < 0) return null;
  // "timeout" (Claude style) or "timeoutSec" (Copilot CLI) next to the command.
  const m = /"timeout(?:Sec)?"\s*:\s*(\d+(?:\.\d+)?)/.exec(text.slice(idx, idx + 400));
  if (!m) return null;
  const n = Number(m[1]);
  return host.msTimeouts ? n / 1000 : n;
}
