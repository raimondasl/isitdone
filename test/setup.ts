/**
 * Every test runs against a throwaway HOME so nothing can touch the developer's real
 * ~/.claude, ~/.codex, ~/.cursor or ~/.gemini settings. Spawned CLIs inherit it via process.env.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

let fakeHome: string | null = null;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'isitdone-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  // The suite itself may be running as an isitdone check (CI does exactly that). The nested-run guard and
  // doctor mode must not leak into the in-process tests.
  delete process.env.ISITDONE;
  delete process.env.ISITDONE_DOCTOR;
  delete process.env.ISITDONE_DEBUG;
});

afterAll(() => {
  if (fakeHome) {
    try {
      rmSync(fakeHome, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignore
    }
  }
});
