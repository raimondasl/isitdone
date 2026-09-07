import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { detectChecks } from './detect.js';
import { readJsonFile, stripBom } from './fsutil.js';
import { detectHosts, getHost, HOST_NAMES, type HostAdapter, type HostName } from './hosts.js';
import { RECEIPT_DIR } from './git.js';
import { budgetSeconds } from './verify.js';

export interface InitOptions {
  root: string;
  /** Hosts to install into. "auto" = every host with a settings dir in the repo (or in HOME when scope is user). */
  hosts: HostName[] | 'auto' | 'all';
  scope: 'project' | 'user';
  /** Hook command; defaults to `npx -y <package> hook --host <name>`. */
  command?: (host: HostAdapter) => string;
  /** Hook timeout in seconds. Default: enough for every detected check plus a margin, at least 600. */
  timeout?: number;
  remove?: boolean;
}

export interface InitResult {
  host: HostName;
  displayName: string;
  path: string;
  scope: 'project' | 'user';
  action: 'added' | 'updated' | 'unchanged' | 'removed' | 'absent';
  command: string;
  timeout: number;
  note: string | null;
}

export const DEFAULT_HOOK_TIMEOUT_S = 600;
/** Startup margin for npx resolution and git hashing, in seconds. */
const HOOK_MARGIN_S = 60;
export const PACKAGE_NAME = '@aivolution/isitdone';

export function defaultCommand(host: HostAdapter): string {
  return `npx -y ${PACKAGE_NAME} hook --host ${host.name}`;
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
  const targets = opts.remove
    ? // Remove from every scope where our hook is installed, unless hosts were named explicitly.
      installedHooks(opts.root)
        .filter((h) => opts.hosts === 'auto' || opts.hosts === 'all' || (opts.hosts as HostName[]).includes(h.host.name))
        .map((h) => ({ host: h.host, scope: h.scope }))
    : resolveHosts(opts.root, opts.hosts, opts.scope);
  if (opts.remove && targets.length === 0) {
    for (const { host, scope } of resolveHosts(opts.root, opts.hosts, opts.scope)) {
      results.push({ host: host.name, displayName: host.displayName, path: host.settingsPath(opts.root, scope), scope, action: 'absent', command: '', timeout, note: null });
    }
    return results;
  }
  for (const { host, scope } of targets) {
    const path = host.settingsPath(opts.root, scope);
    const command = (opts.command ?? defaultCommand)(host);
    const settings = readSettings(path);
    const before = host.registered(settings);
    if (opts.remove) {
      const changed = host.unregister(settings);
      if (changed) writeSettings(path, settings);
      results.push({ host: host.name, displayName: host.displayName, path, scope, action: changed ? 'removed' : 'absent', command: before ?? command, timeout, note: null });
      continue;
    }
    const changed = host.register(settings, command, timeout);
    if (changed) writeSettings(path, settings);
    results.push({
      host: host.name,
      displayName: host.displayName,
      path,
      scope,
      action: !changed ? 'unchanged' : before ? 'updated' : 'added',
      command,
      timeout,
      note: host.postInstallNote,
    });
  }
  return results;
}

/** Which hosts currently have an isitdone hook, checking project then user scope. */
export function installedHooks(root: string): Array<{ host: HostAdapter; scope: 'project' | 'user'; path: string; command: string; timeout: number | null }> {
  const out: Array<{ host: HostAdapter; scope: 'project' | 'user'; path: string; command: string; timeout: number | null }> = [];
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
      const command = host.registered(settings);
      if (command) out.push({ host, scope, path, command, timeout: registeredTimeout(settings, command, host) });
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
