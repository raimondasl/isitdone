# isitdone

**Don't let your coding agent say "done" until the tests actually pass.**

`isitdone` is a zero-LLM, zero-dependency Stop hook and CLI for Claude Code, Codex CLI, Cursor and Gemini CLI. When the agent tries to end its turn claiming the work is complete, `isitdone` runs the repository's *real* test, typecheck and lint commands on the *exact* working tree, and refuses the stop until they pass. Every run leaves a git-bound receipt you can paste into a PR.

```
npx @aivolution/isitdone init
```

No API keys. No network. No telemetry. Just exit codes.

## The moment it exists for

Claude Code ends its turn with:

> Done. All 4 tests pass and the auth refactor is complete.

The Stop hook runs `isitdone` before that turn is allowed to end. The agent receives this instead:

```
isitdone: NOT DONE. 1 check failed on the current working tree (attempt 1/3).
You claimed: "All 4 tests pass and the auth refactor is complete."

  npm run typecheck  PASS
  npm run lint       PASS
  npm test           FAIL  1 failed, 3 passed

--- npm test (last 24 lines) ---
✖ failing tests:

test at test/auth.test.js:14:1
✖ is case-insensitive about the scheme (1.498ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  null !== 'abc'
  ...

Fix the failures, then run `npx @aivolution/isitdone` and paste its output before claiming completion.
Do not skip, delete or weaken tests to make this pass; if a check is wrong for this repo,
say so explicitly to the user.
```

The agent keeps working. When it genuinely finishes:

```
$ npx @aivolution/isitdone
isitdone  main@2429c82  dirty (1 file)

  npm run typecheck  PASS  428ms
  npm run lint       PASS  411ms
  npm test           PASS  532ms

  DONE   receipt -> PASS (tree e5e47d9, 3 checks, 1.8s)
```

```
$ npx @aivolution/isitdone receipt --md        # paste into the PR
| check | result | time |
|---|---|---|
| `npm run typecheck` | PASS | 428ms |
| `npm run lint` | PASS | 411ms |
| `npm test` | PASS | 532ms |

Tree e5e47d9 on main@2429c82 (+1 uncommitted). Receipt: **PASS** · isitdone 0.1.0
```

Edit one more file and the receipt goes **STALE** until the checks run again. A hand-edited receipt reads **NONE**.

## Install

One command per host. Run it inside the repository.

| Host | Command | Where it writes |
|---|---|---|
| Claude Code | `npx @aivolution/isitdone init` | `.claude/settings.json` (Stop) |
| Codex CLI | `npx @aivolution/isitdone init --agent codex` | `.codex/hooks.json` (Stop), then run `/hooks` in Codex and trust it |
| Cursor | `npx @aivolution/isitdone init --agent cursor` | `.cursor/hooks.json` (stop) |
| Gemini CLI | `npx @aivolution/isitdone init --agent gemini` | `.gemini/settings.json` (AfterAgent) |
| Everything | `npx @aivolution/isitdone init --agent all` | all of the above |

`init` detects the checks, writes the hook idempotently, adds `.isitdone/` to `.gitignore`, and runs `doctor`, which pipes a synthetic "all tests pass" stop event through the hook and proves it blocks:

```
$ npx @aivolution/isitdone init
isitdone init  ~/work/demo-app
  detected   npm run typecheck, npm run lint, npm test
  profile    claim-gated  (lite checks on every stop, full checks when the agent claims done)
  gitignore  added .isitdone/
  Claude Code added           .claude/settings.json

isitdone doctor  ~/work/demo-app
  ok  git            main@2429c82, 0 dirty file(s), tree 8d11d2f
  ok  config         no .isitdone.json (auto-detect only)
  ok  checks         typecheck: npm run typecheck [lite, 60s]; lint: npm run lint [lite, 60s]; test: npm test [full, 120s]
  ok  hook:claude    Claude Code (project) .claude/settings.json -> npx -y @aivolution/isitdone hook --host claude
  ok  probe:claude   synthetic "tests pass" stop was blocked in 1.9s (decision block with reason)

  OK   the agent cannot claim done with failing checks in this repo
```

Add `--user` to install into your user-level settings instead of the project. `npx @aivolution/isitdone uninstall` removes it. Teach the agent to run it itself with `npx skills add raimondasl/isitdone` (the [`SKILL.md`](SKILL.md) is at the repo root).

Faster hooks: `npm i -D @aivolution/isitdone` makes `npx @aivolution/isitdone` resolve locally with no registry lookup.

## How it decides

1. **Detect.** Reads `package.json` scripts (`test`, `typecheck`, `lint`, `build`; npm, pnpm, yarn, bun, deno), `pyproject.toml`/`pytest.ini`/`requirements.txt` (pytest, ruff, flake8, mypy, pyright; uv/poetry/pipenv runners), `go.mod` (`go vet`, `go test ./...`), `Cargo.toml` (`cargo check`, `cargo test`), .NET solutions, Gradle/Maven, and `Makefile` targets. Anything can be overridden in `.isitdone.json`.
2. **Gate on the claim.** The default `claim-gated` profile runs the fast *lite* checks (typecheck, lint) on every stop, and the *full* checks (tests, build) only when the agent's final message contains a completion claim: "tests pass", "done", "implemented", "verified", "ready for review", and so on. A question or a progress update does not trigger a two-minute test run. Hosts that do not pass the final message (Cursor) get the full profile, cached per tree.
3. **Cache per tree.** The working tree (tracked changes *and* untracked files) is hashed with a temporary git index. A PASS receipt for the same tree hash and the same check configuration is reused; nothing runs twice for nothing.
4. **Run and decide.** Checks run in a fresh subprocess with `CI=true`, per-check timeouts, and the last 30 lines captured. If anything fails, the hook returns the host's block shape with a bounded, plain-text reason quoting the claim and the failing output. If everything passes, the receipt is written and the agent may stop.
5. **Never loop forever.** The hook honours each host's `stop_hook_active` / `loop_count`, counts its own attempts per session (default cap 3), and after the cap lets the agent stop with a visible warning. Malformed stdin, a broken config, or an internal error always allow the stop: `isitdone` must never brick the agent.

## CLI

```
npx @aivolution/isitdone                      run all checks, write the receipt, exit 0 (DONE) or 1 (NOT DONE)
npx @aivolution/isitdone --profile lite       typecheck + lint only
npx @aivolution/isitdone --json               {"ok", "done", "checks": [...]} for scripts and orchestrators
npx @aivolution/isitdone --no-cache           re-run even if a PASS receipt exists for this tree
npx @aivolution/isitdone --all                keep running tests even if typecheck failed
npx @aivolution/isitdone receipt [--md|--json] state of the current tree: PASS | FAIL | STALE | NONE (exit 0 only on full PASS)
npx @aivolution/isitdone detect [--json]      which checks would run and where they came from
npx @aivolution/isitdone init [--agent ...]   install the Stop hook (claude | codex | cursor | gemini | all | auto)
npx @aivolution/isitdone doctor               prove the installed hook blocks; show detected checks and host notes
npx @aivolution/isitdone uninstall            remove the hook(s)
```

For orchestrators and agent loops, `npx @aivolution/isitdone --json` is a done-predicate: `done` is `true` only when every full check passed on the current tree. Exit codes: `0` done, `1` not done, `3` usage or internal error.

## Configuration

Optional. `.isitdone.json` at the repo root, or an `"isitdone"` key in `package.json`:

```jsonc
{
  "checks": {
    "test": "npm run test:unit",                    // replace a detected command
    "lint": false,                                  // disable one
    "e2e": { "cmd": "playwright test", "kind": "full", "timeout": 600 },  // add one
    "smoke": { "cmd": "./smoke.sh", "kind": "lite" }
  },
  "profile": "claim-gated",   // claim-gated (default) | lite | full
  "timeout": 120,             // seconds per full check
  "liteTimeout": 60,          // seconds per lite check
  "maxAttempts": 3,           // consecutive blocks before the agent may stop anyway
  "build": false,             // include the build script even when tests exist
  "claimPatterns": ["ship it"] // extra completion-claim regexes
}
```

`kind: "lite"` checks run on every stop; `kind: "full"` checks run when the agent claims completion. `test` and `build` default to full, `typecheck`, `lint`, `check` and `vet` default to lite.

## What it is not

- **Not a lie detector.** It does not grade the agent's sentences; it runs commands and reads exit codes. The claim only decides *how much* to run.
- **Not adversarial security.** The receipt is HMAC-signed so a hand-edited file reads NONE, and the tree hash makes a stale receipt visible, but an agent with permission to edit settings can remove the hook. `isitdone` guards honest mistakes, which is where nearly all "tests pass" fiction comes from.
- **Not a test-weakening detector, yet.** Deleted tests, new `.skip`s, and loosened assertions are the next release (see roadmap). Today the block reason tells the agent not to do that, and the receipt records the check configuration hash so a loosened gate is visible.
- **Not an LLM.** Nothing here calls a model, phones home, or needs a key.

## Related tools

| Tool | What it does | Relation |
|---|---|---|
| [oh-my-agent](https://github.com/first-fluke/oh-my-agent) | Multi-agent framework that includes a stop-hook gate running typecheck/test/lint | `isitdone` is that gate as a standalone primitive for any host, with receipts and claim-gating |
| [taskmaster](https://github.com/blader/taskmaster) | Blocks the stop until a completion token appears | Token-based; does not run the checks |
| [gutcheck](https://www.npmjs.com/package/gutcheck) | Diff-scoped mutation probe with a Claude Code stop hook | Complementary second gate; `isitdone` verifies the suite passes, gutcheck verifies the suite means something |
| [checkwash](https://github.com/taipei49314/checkwash), [testseal](https://github.com/satwiksps/testseal) | Diff scanners for weakened tests | Diff-only; `isitdone` runs the checks (diff scanning is on the roadmap) |
| [ProofRun](https://github.com/yebiguo/ProofRun) | Tree-bound PASS/FAIL/STALE receipts with hand-written config | Similar receipt idea; `isitdone` auto-detects and hooks into the agents |

## Roadmap

- **v0.2** Test-integrity scan over the diff (deleted tests, new skips, weakened assertions, neutered CI) with severity tiers and inline `// isitdone: allow <reason>` suppressions; `isitdone history` to measure, from your own local Claude Code transcripts, what share of past "done" claims had no test run behind them; plugin marketplace entry.
- **v0.3** Warn-only PostToolUse / afterFileEdit hook on test-file edits; a GitHub Action that re-runs the checks and posts the receipt on the PR; a labelled benchmark corpus with published precision/recall for each detector.

## Development

```
npm ci
npm test            # vitest, runs in a throwaway HOME so it never touches your real agent settings
npm run typecheck
npm run build       # esbuild -> dist/isitdone.js, single file, no dependencies
node dist/isitdone.js
```

The repository dogfoods itself: CI runs `node dist/isitdone.js --json` on every push.

## License

MIT
