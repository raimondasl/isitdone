import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CheckKind = 'lite' | 'full';
export type Profile = 'claim-gated' | 'lite' | 'full';

export interface CheckConfig {
  /** Shell command to run, e.g. "npm test". */
  cmd: string;
  /** lite checks run on every stop; full checks run only when the agent claims completion (claim-gated). */
  kind?: CheckKind;
  /** Per-check timeout in seconds. */
  timeout?: number;
  /** Working directory relative to the repo root. */
  cwd?: string;
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
  /** How many times the hook may block in one session before letting the agent stop. Default 3. */
  maxAttempts?: number;
  /** Extra completion-claim regexes (case-insensitive) that trigger full checks. */
  claimPatterns?: string[];
  /** Include the build script as a check even when test/typecheck exist. Default false. */
  build?: boolean;
}

export interface LoadedConfig {
  config: IsitdoneConfig;
  /** Where the config came from, for diagnostics. */
  source: string | null;
}

export const CONFIG_FILE = '.isitdone.json';

export function loadConfig(root: string): LoadedConfig {
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as IsitdoneConfig;
      return { config: validate(parsed, CONFIG_FILE), source: CONFIG_FILE };
    } catch (err) {
      throw new Error(`Could not parse ${CONFIG_FILE}: ${(err as Error).message}`);
    }
  }
  const pkgFile = join(root, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { isitdone?: IsitdoneConfig };
      if (pkg.isitdone && typeof pkg.isitdone === 'object') {
        return { config: validate(pkg.isitdone, 'package.json#isitdone'), source: 'package.json#isitdone' };
      }
    } catch {
      // package.json problems are reported by detection, not here
    }
  }
  return { config: {}, source: null };
}

function validate(c: IsitdoneConfig, where: string): IsitdoneConfig {
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
    if (typeof c.checks !== 'object' || Array.isArray(c.checks)) throw new Error(`${where}: checks must be an object`);
    for (const [id, v] of Object.entries(c.checks)) {
      if (v === false || typeof v === 'string') continue;
      if (typeof v !== 'object' || typeof v.cmd !== 'string') throw new Error(`${where}: checks.${id} must be a string, false, or { cmd }`);
      if (v.kind !== undefined && v.kind !== 'lite' && v.kind !== 'full') throw new Error(`${where}: checks.${id}.kind must be lite or full`);
    }
  }
  return c;
}
