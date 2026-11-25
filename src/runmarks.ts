/**
 * A Stop-hook run that the host kills (its hook timeout ran out) leaves nothing behind: no receipt, no decision, and the
 * stop goes through unverified. So each check run leaves a marker in .isitdone/runs/ that it keeps fresh while it runs
 * and removes when it ends. A marker that went stale belongs to a run that was cut off: the next stop in the project
 * logs it ('cut-off') and tells the user, and `history` counts them. Nothing here ever throws or delays a decision.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPT_DIR } from './git.js';
import { ensureStateDir } from './receipt.js';
import { pidGone } from './sessions.js';

export const RUNS_DIR = 'runs';
const BEAT_MS = 15_000;
/** Six missed heartbeats: the process is gone, or so stuck that the host will have given up on it. */
const STALE_MS = 90_000;

export interface RunMark {
  pid: number;
  host: string;
  session: string;
  profile: 'lite' | 'full';
  startedAt: string;
}

export interface CutOff extends RunMark {
  /** How long it ran before it stopped answering (its last heartbeat). */
  ranMs: number;
}

/** Marks a check run as under way; the returned function ends the mark (call it whatever happens). */
export function startRunMark(root: string, mark: Omit<RunMark, 'pid' | 'startedAt'>): () => void {
  const dir = join(root, RECEIPT_DIR, RUNS_DIR);
  const file = join(dir, `${mark.session}-${process.pid}.json`);
  try {
    mkdirSync(join(ensureStateDir(root), RUNS_DIR), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...mark, pid: process.pid, startedAt: new Date().toISOString() } satisfies RunMark));
  } catch {
    return () => {};
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      // a missed beat only risks a late report
    }
  }, BEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    try {
      rmSync(file, { force: true });
    } catch {
      // a leftover marker of a run that ended looks like a cut-off; rare, and only a report
    }
  };
}

const NOTICE_FILE = 'cutoff-notice.json';

interface CutOffNotice {
  count: number;
  longestMs: number;
}

/**
 * Keeps cut-off runs for the next stop that gets as far as telling the user. The stop that finds them may be cut off
 * itself (the case this exists for: checks longer than the hook's timeout), or return early (paused, attempt cap).
 */
export function addCutOffNotice(root: string, cut: CutOff[]): void {
  if (cut.length === 0) return;
  const file = join(root, RECEIPT_DIR, NOTICE_FILE);
  try {
    let prev: CutOffNotice = { count: 0, longestMs: 0 };
    try {
      prev = JSON.parse(readFileSync(file, 'utf8')) as CutOffNotice;
    } catch {
      // none yet
    }
    const next: CutOffNotice = { count: (Number(prev.count) || 0) + cut.length, longestMs: Math.max(Number(prev.longestMs) || 0, ...cut.map((c) => c.ranMs)) };
    writeFileSync(join(ensureStateDir(root), NOTICE_FILE), JSON.stringify(next));
  } catch {
    // the decision log still has them
  }
}

/** Takes the pending notice (once, even with two stops at the same moment). */
export function takeCutOffNotice(root: string): CutOffNotice | null {
  const file = join(root, RECEIPT_DIR, NOTICE_FILE);
  const taken = `${file}.${process.pid}.taken`;
  try {
    renameSync(file, taken);
    const n = JSON.parse(readFileSync(taken, 'utf8')) as CutOffNotice;
    rmSync(taken, { force: true });
    return Number(n.count) > 0 ? { count: Number(n.count), longestMs: Number(n.longestMs) || 0 } : null;
  } catch {
    rmSync(taken, { force: true });
    return null;
  }
}

/**
 * Runs in this project that were cut off: their marker went stale, or their process is gone. Each is claimed by renaming
 * it first, so two stops that look at the same time report it once.
 */
export function collectCutOffs(root: string, now = Date.now()): CutOff[] {
  const dir = join(root, RECEIPT_DIR, RUNS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((e) => e.endsWith('.json'));
  } catch {
    return [];
  }
  const found: CutOff[] = [];
  for (const e of entries) {
    const file = join(dir, e);
    try {
      const lastBeat = statSync(file).mtimeMs;
      const mark = JSON.parse(readFileSync(file, 'utf8')) as Partial<RunMark>;
      if (typeof mark.pid !== 'number' || typeof mark.startedAt !== 'string') {
        rmSync(file, { force: true });
        continue;
      }
      if (mark.pid === process.pid) continue;
      // As with the run lock: a pid that is gone here may live elsewhere (WSL, a container) and still beat, so it counts
      // only after two missed beats.
      if (!(now - lastBeat > STALE_MS || (now - lastBeat > 2 * BEAT_MS + 1_000 && pidGone(mark.pid)))) continue;
      const taken = `${file}.taken`;
      renameSync(file, taken);
      rmSync(taken, { force: true });
      found.push({ pid: mark.pid, host: String(mark.host ?? ''), session: String(mark.session ?? 'anon'), profile: mark.profile === 'lite' ? 'lite' : 'full', startedAt: mark.startedAt, ranMs: Math.max(0, lastBeat - Date.parse(mark.startedAt)) });
    } catch {
      // another stop claimed it, or it vanished
    }
  }
  return found;
}
