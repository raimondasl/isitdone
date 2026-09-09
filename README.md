# isitdone

**Don't let your coding agent say "done" until the tests actually pass.**

<p align="center"><img src="docs/demo.svg" alt="isitdone blocks a false 'done': the Stop hook runs the real tests, they fail, the agent fixes them, the receipt says DONE" width="880"></p>

*Rendered from a real run (`npm run demo`): the agent lines are narration; the hook and CLI output are captured as-is, with only the temporary path shortened.*

`isitdone` is a zero-LLM, zero-dependency Stop hook and CLI for Claude Code, Codex CLI, Cursor, Gemini CLI, GitHub Copilot CLI, Qwen Code, Goose, Factory Droid, Devin, Augment, OpenCode and Junie CLI. When the agent tries to end its turn claiming the work is complete, `isitdone` runs the repository's *real* test, typecheck and lint commands on the *exact* working tree, scans the diff for weakened tests, and refuses the stop until they pass. It also tells the agent mid-turn when an edit just weakened a test, runs the same verification on pull requests as a GitHub Action, and leaves a git-bound receipt you can paste into a PR.

```
npx isitdone init
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

Fix the failures, then run `npx isitdone` and paste its output before claiming completion.
Do not skip, delete or weaken tests to make this pass; if a check is wrong for this repo,
say so explicitly to the user.
```

The agent keeps working. When it genuinely finishes:

```
$ npx isitdone
isitdone  main@2429c82  dirty (1 file)

  npm run typecheck  PASS  428ms
  npm run lint       PASS  411ms
  npm test           PASS  532ms

  DONE   receipt -> PASS (tree e5e47d9, 3 checks, 1.8s)
```

```
$ npx isitdone receipt --md        # paste into the PR
| check | result | time |
|---|---|---|
| `npm run typecheck` | PASS | 428ms |
| `npm run lint` | PASS | 411ms |
| `npm test` | PASS | 532ms |

Tree e5e47d9 on main@2429c82 (+1 uncommitted). Receipt: **PASS** · isitdone 0.1.0
```

Edit one more file and the receipt goes **STALE** until the checks run again. A hand-edited receipt reads **NONE**. (`isitdone` on npm is a short alias of `@aivolution/isitdone`; both commands are the same program.)

## How often does this actually happen?

Measure it on your own machine. `isitdone history` reads the transcripts already on disk: Claude Code (`~/.claude/projects`), Codex CLI (`~/.codex/sessions`: legacy, paginated and pre-0.40 rollouts, honouring `/undo` rollbacks), Gemini CLI (`~/.gemini/tmp/<project>/chats`, both the `.json` and the 0.39+ `.jsonl` layouts), Qwen Code (`~/.qwen/projects/<cwd>/chats`) and Cursor (the IDE's `state.vscdb` bubble store, opened read-only in place, which needs Node 22.13+ or 24 for `node:sqlite`; on Node 20 the `agent-transcripts` JSONL is read instead, which carries no exit codes, and the report says so). It finds every turn where the agent edited files and then claimed completion, and checks whether a test command actually passed after the last edit. Nothing leaves your machine; only counts are printed.

```
$ npx isitdone history
isitdone history  ~/.claude/projects
  scanned 591 sessions in 9 projects; 1400 turns edited files; 516 of those ended with a completion claim

  VERIFIED   31%   a test command passed after the last edit
  STALE      37%   tests passed, then more edits, no re-run
  FAILED     0%    the last test run failed, "done" claimed anyway
  NEVER RAN  31%   no test command in the turn at all

  69% of "done" claims had no passing test run behind them.
```

That is the author's real result over seven months of sessions. Post yours.

## Install

One command per host. Run it inside the repository.

| Host | Command | Where it writes |
|---|---|---|
| Claude Code | `npx isitdone init` | `.claude/settings.json` (Stop) |
| Codex CLI | `npx isitdone init --agent codex` | `.codex/hooks.json` (Stop), then run `/hooks` in Codex and trust it |
| Cursor | `npx isitdone init --agent cursor` | `.cursor/hooks.json` (stop) |
| Gemini CLI | `npx isitdone init --agent gemini` | `.gemini/settings.json` (AfterAgent) |
| GitHub Copilot CLI | `npx isitdone init --agent copilot` | `.github/hooks/isitdone.json` (agentStop); restart Copilot |
| Qwen Code | `npx isitdone init --agent qwen` | `.qwen/settings.json` (Stop) |
| Goose | `npx isitdone init --agent goose` | `.agents/plugins/isitdone/hooks/hooks.json` (Stop) |
| Factory Droid | `npx isitdone init --agent droid` | `.factory/hooks.json` (Stop) |
| Devin | `npx isitdone init --agent devin` | `.devin/hooks.v1.json` (Stop); skipped when the Claude Code hook is present, since Devin loads that too |
| Augment (Auggie) | `npx isitdone init --agent augment` | `.augment/settings.json` (Stop) pointing at `.augment/hooks/isitdone-hook.sh`/`.cmd`, since Auggie runs script files |
| OpenCode | `npx isitdone init --agent opencode` | `.opencode/plugins/isitdone.js` (a plugin: OpenCode has no blocking hook, so failed checks come back as a visible `[isitdone]` follow-up message in the same session) |
| Junie CLI (early access) | `npx isitdone init --agent junie --user` | `~/.junie/config.json` (Stop) |
| Everything | `npx isitdone init --agent all` | all of the above that apply to the repo |

`init` detects the checks, writes the Stop hook and (for Claude Code, Codex, Gemini CLI, Qwen Code, Devin and OpenCode) a warn-only post-edit hook, adds `.isitdone/` to `.gitignore`, and runs `doctor`, which pipes a synthetic "all tests pass" stop event through the hook and proves it blocks:

```
$ npx isitdone init
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

Claude Code users can also install it as a plugin: `/plugin marketplace add raimondasl/isitdone` then `/plugin install isitdone@isitdone`. A paste-to-agent version of these instructions is in [docs/install.md](docs/install.md).

Add `--user` to install into your user-level settings instead of the project. `npx isitdone uninstall` removes it. Teach the agent to run it itself with `npx skills add raimondasl/isitdone` (the [`SKILL.md`](SKILL.md) is at the repo root).

The code lives in the [`@aivolution/isitdone`](https://www.npmjs.com/package/@aivolution/isitdone) package; `isitdone` on npm is a short alias with the same command, and installed hooks always call the canonical package. `npm i -D @aivolution/isitdone` makes the hook resolve locally, with no registry lookup and offline.

## Updating

The hook runs through `npx`, which keeps its own install cache and does not refresh an unpinned package by itself. To move the hook to the latest release:

```
npx isitdone update          # clears the cached copies of both packages and re-warms them
npx isitdone update --check  # only reports whether a newer release exists
```

`doctor` reports the version the hook actually runs and mentions when a newer release is available. Projects that installed `@aivolution/isitdone` as a dev dependency update it with `npm update @aivolution/isitdone` instead.

## Mid-turn warnings

The Stop hook is the gate; the post-edit hook is the nudge. On Claude Code, Codex, Gemini CLI, Qwen Code, Devin and OpenCode, `init` also registers a hook that runs after every `Edit`/`Write` (Codex and Devin: `apply_patch`, Gemini and Qwen: `write_file`/`replace`, OpenCode: `edit`/`write`/`apply_patch`). It scans just that file against `HEAD` (so it sees every uncommitted change to the file, not only the lines this edit touched) and, when the tests got weaker, adds a short factual note next to the tool result:

```
isitdone: after your edit, src/auth.test.ts has weaker tests than HEAD (Tests 4 -> 4   Assertions 6 -> 4   Skipped 0 -> 1):
  - line 12: test skipped or marked expected-failure [high]
  - line 30: assertion weakened: toEqual -> existence check [medium]
If this is intentional, or the change was already there before your edit, tell the user why; otherwise restore the tests. The Stop hook will run the full checks before you can finish.
```

It never blocks and it is fast (one file, no test run). Cursor has no channel an agent can see after an edit, so there the warning arrives with the Stop hook instead. Skip it with `init --no-edit-hook`; `"integrity": "off"` in the config turns it off as well.

## GitHub Action

The same verification on every pull request, from a clean checkout that never trusts a local receipt:

```yaml
on: { pull_request: {} }
permissions:
  contents: read
  pull-requests: write      # for the sticky PR comment
jobs:
  isitdone:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # exact merge-base for the test-integrity diff
      - uses: raimondasl/isitdone@v0
```

It runs the repo's checks, scans the diff against the PR base for weakened tests (strict by default: high/critical findings fail the job even when the checks pass), writes the receipt to the job summary, keeps one updated comment on the PR, and can upload the findings as SARIF (`with: { sarif: 'true' }`, needs `security-events: write` on push events). On pull requests from forks the default token is read-only, so the comment is skipped and the job summary carries the receipt; pass a `token` with write access (a PAT or a GitHub App token) or run on `pull_request_target` to comment there too. `base` accepts a branch (default: the PR base), a commit sha, a tag or a qualified ref. Inputs: `version`, `base`, `strict`, `comment`, `sarif`, `token`, `args`, `command`; outputs: `status`, `report`, `json` (the path of the `--json-file` result).

## How it decides

1. **Detect.** Reads `package.json` scripts (`test`, `typecheck`, `lint`, `build`; npm, pnpm, yarn, bun, deno), `pyproject.toml`/`pytest.ini`/`requirements.txt` (pytest, ruff, flake8, mypy, pyright; uv/poetry/pipenv runners), `go.mod` (`go vet`, `go test ./...`), `Cargo.toml` (`cargo check`, `cargo test`), .NET solutions, Gradle/Maven, and `Makefile` targets. Anything can be overridden in `.isitdone.json`.
2. **Gate on the claim.** The default `claim-gated` profile runs the fast *lite* checks (typecheck, lint) on every stop, and the *full* checks (tests, build) only when the agent's final message contains a completion claim: "tests pass", "done", "implemented", "verified", "ready for review", and so on. A question or a progress update does not trigger a two-minute test run. Hosts that do not pass the final message (Cursor, Copilot CLI, Factory Droid, Devin, Junie) get the full profile, cached per tree.
3. **Cache per tree.** The working tree (tracked changes *and* untracked files, including the contents of submodules and embedded repositories) is hashed with a temporary git index, without writing any blob into `.git/objects`. A PASS receipt for the same tree hash and the same check configuration is reused; nothing runs twice for nothing.
4. **Run and decide.** Checks run in a fresh subprocess with `CI=true`, per-check timeouts, and the last 30 lines captured. If anything fails, the hook returns the host's block shape with a bounded, plain-text reason quoting the claim and the failing output. If everything passes, the receipt is written and the agent may stop.
5. **Scan the diff for weakened tests.** Deleted test files, new `.skip`/`.only`/`xfail`, dropped assertions, matchers downgraded (`toStrictEqual` to `toEqual`, `toThrow("msg")` to `toThrow()`, `assertEqual` to `assertTrue`), widened tolerances, empty `catch`/`except: pass`, and neutered configuration (`|| true`, `--passWithNoTests`, `continue-on-error`, `testPathIgnorePatterns`, `-DskipTests`, `ignoreFailures`, `cargo test -- --skip`, removed CI test steps). JS/TS, Python, Go, Rust (`#[ignore]`, `#[should_panic]` loosened, `assert_eq!` to `is_ok()`, inline `#[cfg(test)]` modules found by content), Java/Kotlin (JUnit 4/5, TestNG, AssertJ, Hamcrest; `@Disabled`, `assumeTrue(false)`, `assertEquals` to `assertNotNull`; Kotlin is best effort for JUnit and kotlin.test) and C# (xUnit, NUnit, MSTest; `Skip =`, `[Ignore]`, `Assert.Equal` to `Assert.NotNull`); the build configuration scanned includes Cargo/nextest, Maven/Gradle, csproj/runsettings/xunit.runner.json and the common CI files. Findings are reported with a before/after line (`Tests 47 -> 44   Assertions 112 -> 104   Skipped 0 -> 1`) and recorded in the receipt; with `"integrity": "strict"` (or `--strict`) high/critical findings block the stop even when the checks pass. Suppress a line with `// isitdone: allow <reason>`; suppressions are reported, never hidden, and `--ci` treats new ones as findings.
6. **Never loop forever.** The hook honours each host's `stop_hook_active` / `loop_count` (and counts attempts itself for hosts that send neither), counts its own attempts per session (default cap 3), and after the cap lets the agent stop with a visible warning. Malformed stdin, a broken config, or an internal error always allow the stop: `isitdone` must never brick the agent.

## CLI

```
npx isitdone                      run all checks, write the receipt, exit 0 (DONE) or 1 (NOT DONE)
npx isitdone --profile lite       typecheck + lint only
npx isitdone --json               {"ok", "done", "checks": [...]} for scripts and orchestrators (--json-file <path> writes it)
npx isitdone --no-cache           re-run even if a PASS receipt exists for this tree
npx isitdone --all                keep running tests even if typecheck failed
npx isitdone --strict             block when the change weakened tests (high/critical findings)
npx isitdone --ci                 strict, plus new "isitdone: allow" suppressions count as findings
npx isitdone --base main          scan the diff against a branch instead of HEAD (pull requests)
npx isitdone --report out.md      write a markdown report; --sarif out.sarif writes SARIF 2.1.0 for code scanning
npx isitdone history [--since 30d] [--exclude <substr>] [--verbose] [--min <pct>]
                                  share of past "done" claims backed by a passing test run
                                  (Claude Code, Codex, Gemini CLI, Qwen Code and Cursor transcripts, local only)
npx isitdone receipt [--md|--json] state of the current tree: PASS | FAIL | STALE | NONE (exit 0 only on full PASS)
npx isitdone detect [--json]      which checks would run and where they came from
npx isitdone init [--agent ...]   install the Stop hook (claude | codex | cursor | gemini | copilot | qwen | goose | droid |
                                  devin | augment | opencode | junie | all | auto)
npx isitdone doctor               prove the installed hook blocks; show detected checks and host notes
npx isitdone uninstall            remove the hook(s)
```

For orchestrators and agent loops, `npx isitdone --json` is a done-predicate: `done` is `true` only when every full check passed on the current tree. Exit codes: `0` done, `1` not done, `3` usage or internal error.

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
  "claimPatterns": ["ship it"], // extra completion-claim regexes
  "integrity": "warn",        // warn (default) | strict | off
  "history": { "exclude": ["client-x"] }  // project paths to skip in `isitdone history`
}
```

`kind: "lite"` checks run on every stop; `kind: "full"` checks run when the agent claims completion. `test` and `build` default to full, `typecheck`, `lint`, `check` and `vet` default to lite.

## What it is not

- **Not a lie detector.** It does not grade the agent's sentences; it runs commands and reads exit codes. The claim only decides *how much* to run.
- **Not adversarial security.** The receipt is HMAC-signed so a hand-edited file reads NONE, and the tree hash makes a stale receipt visible, but an agent with permission to edit settings can remove the hook. `isitdone` guards honest mistakes, which is where nearly all "tests pass" fiction comes from.
- **Not an AST.** The test-integrity scan is line-and-regex over the diff with a small, published detector list. It catches the common ways an agent makes red go green without fixing anything; it will miss clever ones (a test's expected value bent to match a regression, for one) and occasionally flag a legitimate refactor, which is why it warns by default and every finding shows its evidence. Its precision and recall are measured on a labelled corpus in [`bench/`](bench/) (`npm run bench`; 118 hand-labelled cases at the time of writing, 100% precision, 98% recall) that grows with every reported mistake.
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

- **v0.5** A `--related` mode that runs only the tests touching the changed files for slow suites; Cline (a PreToolUse gate on `attempt_completion`) and Amp (`agent.end` plugin) adapters; a native OpenCode hook once `session.stopping` ships, and Windsurf/Cascade once its hooks can block; `history` for OpenCode's database; Kotest/Spek DSLs; a detector for expected values bent to match a regression.
- Not planned: Roo Code and Kilo Code (no hooks), Kiro (its Stop trigger cannot block), Crush (PreToolUse only). Aider has no hooks but `aider --auto-test --test-cmd "npx isitdone"` feeds the same verdict back after every edit.

## Development

```
npm ci
npm test            # vitest, runs in a throwaway HOME so it never touches your real agent settings
npm run typecheck
npm run build       # esbuild -> dist/isitdone.js (CLI) and dist/index.js (library), no dependencies
npm run bench       # precision/recall of the test-integrity scanner over bench/cases/
node dist/isitdone.js
```

The repository dogfoods itself: CI runs `node dist/isitdone.js --json` on every push, and pull requests run the GitHub Action. The library is importable too: `import { verify, scanIntegrity } from '@aivolution/isitdone'`.

## License

MIT
