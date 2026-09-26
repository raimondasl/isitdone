/**
 * A local record of what the Stop hook decided, so `isitdone history` can report what the gate itself did. Transcripts
 * only show the test commands the agent ran; a gate that verifies the tree inside the hook is invisible there, which
 * made gated repositories look worse, not better. One JSON line per stop in `.isitdone/decisions.jsonl` (git-ignored
 * with the rest of `.isitdone/`): no message text, no paths, the session id only as the same hash the state files use.
 * Writing never throws and never delays the decision it records.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPT_DIR } from './git.js';
import { ensureStateDir } from './receipt.js';

export const DECISIONS_FILE = 'decisions.jsonl';
/** Past this size the log keeps its newest half. */
const MAX_BYTES = 512 * 1024;

/**
 * passed / passed-lite / passed-cached: the checks (all, lite only, or a receipt for this exact tree) passed.
 * blocked: the stop was refused. gave-up: blocked maxAttempts times, allowed with a warning. released: allowed after
 * one block because the failure named only another session's files. unenforced: failed, but state could not be kept.
 * no-checks: nothing detected to run. paused: background tasks and no claim. error: a broken config.
 */
export type GateKind = 'passed' | 'passed-lite' | 'passed-cached' | 'blocked' | 'gave-up' | 'released' | 'unenforced' | 'no-checks' | 'paused' | 'error';

export interface GateRecord {
  t: string;
  host: string;
  /** Hashed session key (host + sha1 of the id), as in .isitdone/sessions. */
  session: string;
  kind: GateKind;
  /** Did the final message claim completion? null when the host does not pass the message. */
  claim: boolean | null;
  profile: 'lite' | 'full' | null;
  /** Blocks so far in this turn, including this one. */
  attempts: number;
  checks: number;
  failed: number;
}

export function appendDecision(root: string, rec: GateRecord): void {
  try {
    const file = join(ensureStateDir(root), DECISIONS_FILE);
    appendFileSync(file, JSON.stringify(rec) + '\n');
    if (statSync(file).size > MAX_BYTES) {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
      writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch {
    // an unwritable .isitdone/ costs the statistics, never the decision
  }
}

export function readDecisions(root: string, since: Date | null = null, until: Date | null = null): GateRecord[] {
  let text: string;
  try {
    text = readFileSync(join(root, RECEIPT_DIR, DECISIONS_FILE), 'utf8');
  } catch {
    return [];
  }
  const out: GateRecord[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const r = JSON.parse(line) as GateRecord;
      if (typeof r.t !== 'string' || typeof r.kind !== 'string') continue;
      if (since && Date.parse(r.t) < since.getTime()) continue;
      if (until && Date.parse(r.t) > until.getTime()) continue;
      out.push(r);
    } catch {
      // a torn line
    }
  }
  return out;
}

export interface GateSummary {
  projects: number;
  /** Stops at which checks ran or a receipt was reused. */
  checked: number;
  passed: number;
  /** Turns the gate blocked at least once, and how each of them ended. */
  blockedTurns: number;
  fixed: number;
  gaveUp: number;
  released: number;
  /** Still blocked at the last record (the turn had not ended yet, or its end was not a stop). */
  open: number;
  /** Stops whose final message claimed completion, and how many of those were blocked. */
  claims: number;
  claimsBlocked: number;
  other: number;
}

const PASSED = new Set<GateKind>(['passed', 'passed-lite', 'passed-cached']);

/** Fold decision records (any order, any number of projects) into turns and counts. */
export function summarizeDecisions(byProject: GateRecord[][]): GateSummary {
  const s: GateSummary = { projects: 0, checked: 0, passed: 0, blockedTurns: 0, fixed: 0, gaveUp: 0, released: 0, open: 0, claims: 0, claimsBlocked: 0, other: 0 };
  for (const records of byProject) {
    if (records.length === 0) continue;
    s.projects++;
    const bySession = new Map<string, GateRecord[]>();
    for (const r of records) {
      const list = bySession.get(r.session) ?? [];
      list.push(r);
      bySession.set(r.session, list);
    }
    for (const list of bySession.values()) {
      list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
      let inBlockedTurn = false;
      for (const r of list) {
        if (PASSED.has(r.kind) || r.kind === 'blocked') s.checked++;
        if (PASSED.has(r.kind)) s.passed++;
        if (r.claim === true) {
          s.claims++;
          if (r.kind === 'blocked') s.claimsBlocked++;
        }
        if (r.kind === 'blocked') {
          if (!inBlockedTurn) s.blockedTurns++;
          inBlockedTurn = true;
          continue;
        }
        if (inBlockedTurn) {
          if (PASSED.has(r.kind)) s.fixed++;
          else if (r.kind === 'gave-up' || r.kind === 'unenforced') s.gaveUp++;
          else if (r.kind === 'released') s.released++;
          else s.other++;
          inBlockedTurn = false;
        }
      }
      if (inBlockedTurn) s.open++;
    }
  }
  return s;
}
