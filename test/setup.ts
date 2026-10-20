/**
 * Every test runs against a throwaway HOME so nothing can touch the developer's real
 * ~/.claude, ~/.codex, ~/.cursor, ~/.gemini, ~/.qwen, ~/.junie ... settings. Spawned CLIs inherit it via process.env.
 * Hosts that resolve their user dir through other variables (%APPDATA% for Devin, XDG_CONFIG_HOME for OpenCode,
 * COPILOT_HOME) are pointed at the fake home too.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { AGENT_SHELL_MARKERS } from '../src/pause.js';

let fakeHome: string | null = null;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'isitdone-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.APPDATA = join(fakeHome, 'AppData', 'Roaming');
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.COPILOT_HOME;
  // Host-provided project dirs would override the payload-less fallbacks under test.
  delete process.env.DEVIN_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CONTINUE_PROJECT_DIR;
  delete process.env.FACTORY_PROJECT_DIR;
  // The suite itself may be running as an isitdone check (CI does exactly that). The nested-run guard and
  // doctor mode must not leak into the in-process tests.
  delete process.env.ISITDONE;
  delete process.env.ISITDONE_DOCTOR;
  delete process.env.ISITDONE_DEBUG;
  // The suite is often run by an agent; `isitdone pause` refuses to run in an agent's shell, and tests say when it is one.
  for (const v of AGENT_SHELL_MARKERS) delete process.env[v];
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
