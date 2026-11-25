import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from './fsutil.js';
import { ignorePatternError } from './ignore.js';

export type CheckKind = 'lite' | 'full';
export type Profile = 'claim-gated' | 'lite' | 'full';

export interface CheckConfig {
  /** Shell command to run, e.g. "npm test". Without it the entry adjusts the detected check of the same id. */
  cmd?: string;
  /** lite checks run on every stop; full checks run only when the agent claims completion (claim-gated). */
  kind?: CheckKind;
  /** Per-check timeout in seconds. */
  timeout?: number;
  /** Working directory relative to the repo root. */
  cwd?: string;
  /**
   * Paths (relative to the project root, .gitignore-style) this check never reads. While only these change, the
   * check's last pass is reused instead of running it again. List only what the check really never reads.
   */
  ignore?: string[];
}

export interface IsitdoneConfig {
  /** Override or disable detected checks by id, or add custom ones. */
  checks?: Record<string, string | false | CheckConfig>;
  /** How the Stop hook decides what to run. Default: claim-gated. */
  profile?: Profile;
  /** Default per-check timeout in seconds for full checks. Default 120. */
  timeout?: number;
  /** Default per-check timeout in seconds for lite checks. Default 60. */
  liteTimeout?: number;
  /** How many times the hook may block in one turn before letting the agent stop. Default 3. */
  maxAttempts?: number;
  /** Extra completion-claim regexes (case-insensitive) that trigger full checks. */
  claimPatterns?: string[];
  /** Include the build script as a check even when test/typecheck exist. Default false. */
  build?: boolean;
  /** Test-integrity scan: warn (default) reports weakened tests, strict blocks on high/critical findings, off disables it. */
  integrity?: 'warn' | 'strict' | 'off';
  /**
   * Two agent sessions in one working tree: "respect" (default) tells a session which uncommitted files belong to a
   * session working alongside it, blocks it only once for a failure that names none of its own files, and serialises
   * check runs; "ignore" treats the tree as this session's alone (edits are still recorded, nothing reads them).
   */
  otherSessions?: 'respect' | 'ignore';
  /** Settings for `isitdone history`. */
  history?: {
    /** Case-insensitive substrings of project paths to skip. */
    exclude?: string[];
  };
}

export interface LoadedConfig {
  config: IsitdoneConfig;
  /** Where the config came from, for diagnostics. */
  source: string | null;
}

export const CONFIG_FILE = '.isitdone.json';

const CHECK_KEYS = new Set(['cmd', 'kind', 'timeout', 'cwd', 'ignore']);

/** Why a check's "ignore" value cannot be used (it is then dropped and the check runs every time), or null. */
export function ignoreProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'must be an array of path patterns';
  for (const p of value as unknown[]) {
    const problem = ignorePatternError(p);
    if (problem) return `${JSON.stringify(p)} ${problem}`;
  }
  return null;
}

export function loadConfig(root: string): LoadedConfig {
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) {
    let parsed: IsitdoneConfig;
    try {
      parsed = readJsonFile<IsitdoneConfig>(file);
    } catch (err) {
      throw new Error(`Could not parse ${CONFIG_FILE}: ${(err as Error).message}`);
    }
    return { config: validate(parsed, CONFIG_FILE), source: CONFIG_FILE };
  }
  const pkgFile = join(root, 'package.json');
  if (existsSync(pkgFile)) {
    let pkg: { isitdone?: IsitdoneConfig } | null = null;
    try {
      pkg = readJsonFile<{ isitdone?: IsitdoneConfig }>(pkgFile);
    } catch {
      // package.json problems are reported by detection, not here
    }
    if (pkg?.isitdone && typeof pkg.isitdone === 'object') {
      return { config: validate(pkg.isitdone, 'package.json#isitdone'), source: 'package.json#isitdone' };
    }
  }
  return { config: {}, source: null };
}

function validate(c: IsitdoneConfig, where: string): IsitdoneConfig {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${where}: must be a JSON object`);
  if (c.profile !== undefined && !['claim-gated', 'lite', 'full'].includes(c.profile)) {
    throw new Error(`${where}: profile must be one of claim-gated, lite, full`);
  }
  for (const key of ['timeout', 'liteTimeout', 'maxAttempts'] as const) {
    const v = c[key];
    if (v !== undefined && (typeof v !== 'number' || !(v > 0))) {
      throw new Error(`${where}: ${key} must be a positive number`);
    }
  }
  if (c.checks !== undefined) {
    if (typeof c.checks !== 'object' || c.checks === null || Array.isArray(c.checks)) throw new Error(`${where}: checks must be an object`);
    for (const [id, v] of Object.entries(c.checks)) {
      if (v === false || typeof v === 'string') continue;
      if (typeof v !== 'object' || v === null || Array.isArray(v) || (v.cmd !== undefined && typeof v.cmd !== 'string')) {
        throw new Error(`${where}: checks.${id} must be a string, false, or an object with cmd, kind, timeout, cwd or ignore`);
      }
      // Without cmd, a misspelt key ("command") would leave an entry that quietly adjusts nothing. (With cmd, extra keys
      // stay tolerated as they always were.)
      const unknown = v.cmd === undefined ? Object.keys(v).filter((k) => !CHECK_KEYS.has(k)) : [];
      if (unknown.length > 0) throw new Error(`${where}: checks.${id} has unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => JSON.stringify(k)).join(', ')} (allowed: cmd, kind, timeout, cwd, ignore)`);
      if (v.kind !== undefined && v.kind !== 'lite' && v.kind !== 'full') throw new Error(`${where}: checks.${id}.kind must be lite or full`);
      // "ignore" is not validated here: a bad list must not switch the whole gate off. Detection drops it with a note
      // (see ignoreProblem), and the check then simply runs every time.
    }
  }
  if (c.claimPatterns !== undefined && (!Array.isArray(c.claimPatterns) || c.claimPatterns.some((p) => typeof p !== 'string'))) {
    throw new Error(`${where}: claimPatterns must be an array of strings`);
  }
  if (c.integrity !== undefined && !['warn', 'strict', 'off'].includes(c.integrity)) {
    throw new Error(`${where}: integrity must be one of warn, strict, off`);
  }
  if (c.otherSessions !== undefined && !['respect', 'ignore'].includes(c.otherSessions)) {
    throw new Error(`${where}: otherSessions must be one of respect, ignore`);
  }
  if (c.history !== undefined) {
    if (typeof c.history !== 'object' || c.history === null) throw new Error(`${where}: history must be an object`);
    if (c.history.exclude !== undefined && (!Array.isArray(c.history.exclude) || c.history.exclude.some((p) => typeof p !== 'string'))) {
      throw new Error(`${where}: history.exclude must be an array of strings`);
    }
  }
  return c;
}
