import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectHosts, getHost, HOST_NAMES, type HostAdapter, type HostName } from './hosts.js';
import { RECEIPT_DIR } from './git.js';

export interface InitOptions {
  root: string;
  /** Hosts to install into. "auto" = every host with a settings dir in the repo or home. */
  hosts: HostName[] | 'auto' | 'all';
  scope: 'project' | 'user';
  /** Hook command; defaults to `npx -y isitdone hook --host <name>`. */
  command?: (host: HostAdapter) => string;
  /** Hook timeout in seconds. */
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
  note: string | null;
}

export const DEFAULT_HOOK_TIMEOUT_S = 600;

export function defaultCommand(host: HostAdapter): string {
  return `npx -y isitdone hook --host ${host.name}`;
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.trim() === '') return {};
  try {
    const v = JSON.parse(text) as unknown;
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
 * Which hosts to touch. "auto" looks only at the project (.claude/, .codex/, .cursor/, .gemini/ in the repo)
 * and never writes user-level files unless --user was given explicitly; with nothing detected it defaults to Claude Code.
 */
export function resolveHosts(root: string, hosts: InitOptions['hosts'], scope: 'project' | 'user'): Array<{ host: HostAdapter; scope: 'project' | 'user' }> {
  if (hosts === 'all') return HOST_NAMES.map((n) => ({ host: getHost(n), scope }));
  if (hosts === 'auto') {
    const found = detectHosts(root, existsSync)
      .filter((f) => f.scope === 'project')
      .map((f) => ({ host: f.host, scope }));
    return found.length > 0 ? found : [{ host: getHost('claude'), scope }];
  }
  return hosts.map((n) => ({ host: getHost(n), scope }));
}

export function init(opts: InitOptions): InitResult[] {
  const results: InitResult[] = [];
  const timeout = opts.timeout ?? DEFAULT_HOOK_TIMEOUT_S;
  for (const { host, scope } of resolveHosts(opts.root, opts.hosts, opts.scope)) {
    const path = host.settingsPath(opts.root, scope);
    const command = (opts.command ?? defaultCommand)(host);
    const settings = readSettings(path);
    const before = host.registered(settings);
    if (opts.remove) {
      const changed = host.unregister(settings);
      if (changed) writeSettings(path, settings);
      results.push({ host: host.name, displayName: host.displayName, path, scope, action: changed ? 'removed' : 'absent', command: before ?? command, note: null });
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
      note: host.postInstallNote,
    });
  }
  return results;
}

/** Which hosts currently have an isitdone hook, checking project then user scope. */
export function installedHooks(root: string): Array<{ host: HostAdapter; scope: 'project' | 'user'; path: string; command: string }> {
  const out: Array<{ host: HostAdapter; scope: 'project' | 'user'; path: string; command: string }> = [];
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
      if (command) out.push({ host, scope, path, command });
    }
  }
  return out;
}
