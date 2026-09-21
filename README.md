# isitdone

**Don't let your coding agent say "done" until the tests actually pass.**

<p align="center"><img src="docs/demo.svg" alt="isitdone blocks a false 'done': the Stop hook runs the real tests, they fail, the agent fixes them, the receipt says DONE" width="880"></p>

*Rendered from a real run (`npm run demo`): the agent lines are narration; the hook and CLI output are captured as-is, with only the temporary path shortened.*

`isitdone` is a zero-LLM, zero-dependency Stop hook and CLI for Claude Code, Codex CLI, Cursor, Gemini CLI, GitHub Copilot CLI, Qwen Code, Goose, Factory Droid, Devin, Augment, OpenCode and Junie CLI. When the agent tries to end its turn claiming the work is complete, `isitdone` runs the repository's *real* test, typecheck and lint commands on the *exact* working tree, scans the diff for weakened tests, and refuses the stop until they pass. It also tells the agent mid-turn when an edit just weakened a test, runs the same verification on pull requests as a GitHub Action, offers it as an [MCP server](#mcp-server) to agents that have no stop hook, and leaves a git-bound receipt you can paste into a PR.

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

That is the author's real result over seven months of sessions. Post yours. The longer story of why the gate sits where it does is in [docs/why.md](docs/why.md) (also [on DEV](https://dev.to/raimondasl/69-of-my-coding-agents-done-claims-werent-here-is-the-gate-i-put-in-front-of-them-lho), where comments are open).

## Install

One command per host. Run it inside the repository.

| Host | Command | Where it writes |
|---|---|---|
| Claude Code | `npx isitdone init` | `.claude/settings.json` (Stop) |
| Codex CLI | `npx isitdone init --agent codex` | `.codex/hooks.json` (Stop), then run `/hooks` in Codex and trust it |
| Cursor | `npx isitdone init --agent cursor` | `.cursor/hooks.json` (stop) |
| Gemini CLI | `npx isitdone init --agent gemini` | `.gemini/settings.json` (AfterAgent); or `gemini extensions install https://github.com/raimondasl/isitdone-gemini` |
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

Claude Code users can also install it as a plugin: `/plugin marketplace add raimondasl/isitdone` then `/plugin install isitdone@isitdone`. Gemini CLI users can install it as an extension: `gemini extensions install https://github.com/raimondasl/isitdone-gemini` ([isitdone-gemini](https://github.com/raimondasl/isitdone-gemini)). A paste-to-agent version of these instructions is in [docs/install.md](docs/install.md). How each of these agents' end-of-turn hooks works (config file, payload, how to block, loop flags) is written up vendor-neutrally in [docs/agent-hooks.md](docs/agent-hooks.md), with the same table as data in [docs/agent-hooks.json](docs/agent-hooks.json).

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

Listed on the [GitHub Marketplace as isitdone verify](https://github.com/marketplace/actions/isitdone-verify). It runs the repo's checks, scans the diff against the PR base for weakened tests (strict by default: high/critical findings fail the job even when the checks pass), writes the receipt to the job summary, keeps one updated comment on the PR, and can upload the findings as SARIF (`with: { sarif: 'true' }`, needs `security-events: write` on push events). On pull requests from forks the default token is read-only, so the comment is skipped and the job summary carries the receipt; pass a `token` with write access (a PAT or a GitHub App token) or run on `pull_request_target` to comment there too. `base` accepts a branch (default: the PR base), a commit sha, a tag or a qualified ref. Inputs: `version`, `base`, `strict`, `comment`, `sarif`, `token`, `args`, `command`; outputs: `status`, `report`, `json` (the path of the `--json-file` result).

## MCP server

For agents and IDEs that have no stop hook a program can block (VS Code Copilot agent mode, Cline, Windsurf Cascade, Kiro, Zed, JetBrains AI Assistant, Claude Desktop, Amp, Crush, Roo Code), the same verification is available as a Model Context Protocol server:

```
npx -y @aivolution/isitdone mcp
```

**This is the weaker of the two integrations, and it is meant to be.** A hook is enforced by the host: the agent cannot end its turn until the checks pass, whether it wants to or not. An MCP tool runs only when the model decides to call it, and a model that skips the call claims "done" exactly as before. If your agent is in the [Install](#install) table, use the hook (you can run both: they share the receipt). Where there is no hook, a tool the model is told to call still beats a sentence nobody checked.

It offers three tools, and its server instructions tell the model to call `isitdone_verify` before saying that work is complete, to paste the result, and never to weaken tests to make it pass:

| Tool | Arguments | What it returns |
|---|---|---|
| `isitdone_verify` | `cwd?`, `profile?` (`lite` \| `full`), `claim?`, `base?`, `strict?` | The `npx isitdone` run: `done` true/false, every check's status, the tail of the failing output, the test-integrity findings, the receipt state. NOT DONE is a normal result (`isError` stays false), so the model reads it and keeps working. |
| `isitdone_receipt` | `cwd?` | `PASS`, `FAIL`, `STALE` or `NONE` for the current tree. Runs nothing. |
| `isitdone_detect` | `cwd?` | The checks that would run, and where each was detected. Runs nothing. |

Every result is a plain-text report plus the same facts as `structuredContent` (with an `outputSchema`) for clients that read it. Without a `cwd` argument the server uses the client's first workspace root (`roots`), then the directory it was started in.

VS Code, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "isitdone": { "type": "stdio", "command": "npx", "args": ["-y", "@aivolution/isitdone", "mcp"] }
  }
}
```

Cursor (`.cursor/mcp.json`), Claude Desktop (`claude_desktop_config.json`, under Settings, Developer), Cline (MCP Servers, Configure: `cline_mcp_settings.json`) and Windsurf (`~/.codeium/windsurf/mcp_config.json`) share one shape:

```json
{
  "mcpServers": {
    "isitdone": { "command": "npx", "args": ["-y", "@aivolution/isitdone", "mcp"] }
  }
}
```

Claude Code:

```
claude mcp add isitdone -- npx -y @aivolution/isitdone mcp
```

Cursor and Claude Code have real hooks, so there the MCP server is a convenience (the agent can ask for the receipt mid-task), not the gate: keep `npx isitdone init`. On Windows, a client that cannot start `npx` directly takes `"command": "cmd", "args": ["/c", "npx", "-y", "@aivolution/isitdone", "mcp"]`. Claude Desktop has no workspace, so the model has to pass `cwd`. Since nothing forces the call, say it in the agent's rules file as well (`.github/copilot-instructions.md`, `.clinerules`, `.windsurfrules`, `AGENTS.md`): *"Before you tell me work is done, call the isitdone_verify tool and paste its result."*

Details that matter in practice: one verification runs at a time per repository, and a second identical call gets the result of the run in flight; when a client gives up on a slow suite (`notifications/cancelled` after its own tool timeout) the run still finishes and leaves its receipt, so the model's retry is answered at once instead of timing out again; progress notifications are sent per check for clients that ask for them; when the client closes stdin the running check is killed and the server exits. Checks run on pipes, so nothing a test prints can reach the protocol stream. The server is written against the wire format (newline-delimited JSON-RPC 2.0, no SDK, still zero dependencies) and speaks the handshake revisions `2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25` as well as the stateless `2026-07-28` revision (`server/discover`, per-request `_meta`, roots through `input_required`). [`server.json`](server.json) describes it for the official MCP Registry as `io.github.raimondasl/isitdone`; the release workflow publishes it there.

## How it decides

1. **Detect.** Reads `package.json` scripts (`test`, `typecheck`, `lint`, `build`; npm, pnpm, yarn, bun, deno), `pyproject.toml`/`pytest.ini`/`requirements.txt` (pytest, ruff, flake8, mypy, pyright; uv/poetry/pipenv runners), `go.mod` (`go vet`, `go test ./...`), `Cargo.toml` (`cargo check`, `cargo test`), .NET solutions, Gradle/Maven, and `Makefile` targets. Anything can be overridden in `.isitdone.json`.
2. **Gate on the claim.** The default `claim-gated` profile runs the fast *lite* checks (typecheck, lint) on every stop, and the *full* checks (tests, build) only when the agent's final message contains a completion claim: "tests pass", "done", "implemented", "verified", "ready for review", and so on. A question or a progress update does not trigger a two-minute test run. Hosts that do not pass the final message (Cursor, Copilot CLI, Factory Droid, Devin, Junie) get the full profile, cached per tree.
3. **Cache per tree.** The working tree (tracked changes *and* untracked files, including the contents of submodules and embedded repositories) is hashed with a temporary git index, without writing any blob into `.git/objects`. A PASS receipt for the same tree hash and the same check configuration is reused; nothing runs twice for nothing.
4. **Run and decide.** Checks run in a fresh subprocess with `CI=true`, per-check timeouts, and the last 30 lines captured. If anything fails, the hook returns the host's block shape with a bounded, plain-text reason quoting the claim and the failing output. If everything passes, the receipt is written and the agent may stop.
5. **Scan the diff for weakened tests.** Deleted test files, new `.skip`/`.only`/`xfail`, dropped assertions, matchers downgraded (`toStrictEqual` to `toEqual`, `toThrow("msg")` to `toThrow()`, `assertEqual` to `assertTrue`), widened tolerances, empty `catch`/`except: pass`, and neutered configuration (`|| true`, `--passWithNoTests`, `continue-on-error`, `testPathIgnorePatterns`, `-DskipTests`, `ignoreFailures`, `cargo test -- --skip`, removed CI test steps). JS/TS, Python, Go, Rust (`#[ignore]`, `#[should_panic]` loosened, `assert_eq!` to `is_ok()`, inline `#[cfg(test)]` modules found by content), Java/Kotlin (JUnit 4/5, TestNG, AssertJ, Hamcrest; `@Disabled`, `assumeTrue(false)`, `assertEquals` to `assertNotNull`; Kotlin is best effort for JUnit and kotlin.test) and C# (xUnit, NUnit, MSTest; `Skip =`, `[Ignore]`, `Assert.Equal` to `Assert.NotNull`); the build configuration scanned includes Cargo/nextest, Maven/Gradle, csproj/runsettings/xunit.runner.json and the common CI files. Findings are reported with a before/after line (`Tests 47 -> 44   Assertions 112 -> 104   Skipped 0 -> 1`) and recorded in the receipt; with `"integrity": "strict"` (or `--strict`) high/critical findings block the stop even when the checks pass. Suppress a line with `// isitdone: allow <reason>`; suppressions are reported, never hidden, and `--ci` treats new ones as findings.
6. **Never loop forever.** The hook honours each host's `stop_hook_active` / `loop_count` (and counts attempts itself for hosts that send neither), counts its own attempts per session (default cap 3), and after the cap lets the agent stop with a visible warning. Malformed stdin, a broken config, or an internal error always allow the stop: `isitdone` must never brick the agent.

## Two sessions in one working tree

The checks see the whole working tree. When two agent sessions work in the same directory, that tree holds the other session's unfinished files too, and a gate that ignores this blames whichever session stops first and tells it to "fix" work that is not its own. `isitdone` keeps the two apart, under one rule: **a session on its own is gated as before.** Anything softer needs proof that another session has work in progress here.

- The post-edit hook records which session edited which file (`.isitdone/sessions/` at the repository top: paths and timestamps, local, never committed).
- **Proof of work in progress** is all of: hook activity of another session *after this session's first* and within the last hour; edits it recorded *after its own last passing stop* (a stop that proved the whole tree: every check, not a pause that ran only lint or nothing); and those files still uncommitted. So a conversation that ended before this one began (`/clear`, a restart, yesterday's session) is not "another session", and a session that finished its turn with passing checks (or a one-shot helper that passed and exited) has nothing in progress: its files were good when it left them, so a failure in them now is a later change's doing, and the session that made that change is held to it in full.
- With that proof, every block reason starts with the other session's files and a plain instruction: do not edit, revert or "fix" them, and do not run git commands that would discard them (`checkout`, `restore`, `reset`, `stash`, `clean`).
- A failure whose output names a file this session edited blocks as usual, up to `maxAttempts`.
- A failure whose output names none of this session's files blocks **once**. The agent is asked to work out whether its change caused it (a changed type or fixture breaks files it never opened) and to fix its own change if so; at its next stop the checks run again, and if the output still names none of its files it may stop. The user is told, and the receipt says FAIL, because the tree is not verified. Nothing is released without a block in that turn and without the checks having run on that stop. (A block that already carried the instruction counts as the one telling.)
- A session with no edit records at all (a host without a post-edit hook, or edits made only through the shell) gets no leniency, for failing checks or for strict test-integrity findings: without evidence of what it touched, it is gated as if it were alone. It is told which files the other session is editing and not to discard that session's changes.
- Otherwise, test-integrity findings in the other session's files are left to that session, and the stop message says how many were.
- With a concurrent session, the full checks run even when a lite check failed, so a lint error in the other session's file cannot hide this session's failing tests.
- Check runs are serialised per project, from the Stop hook, the CLI and the MCP server alike: a run waits (up to three minutes; from the hook, less when the checks themselves need most of the hook's time limit) for a run in progress instead of running the suite on top of it. A cached PASS never waits. Receipts are kept honest about edits made while checks were already running: after a wait, the other run's PASS is reused only if that run *started* on this exact tree; a run during which a session recorded an edit, or an existing file was modified or deleted, binds its receipt to the tree it started on (with a warning); and a session never takes a cached PASS from a run that began before its own latest recorded edit.

What "names a file" means: the repo-relative path, an absolute path under the repository, or the shorter path a check prints when it runs from a sub-directory or a workspace, provided only one file in the repository ends that way; a bare `Name.java:17` counts only for a distinctive name that is unique in the repository. Colour codes are stripped first, and on Windows and macOS the comparison ignores case.

Limits worth knowing. The records come from the post-edit hook, so ownership is known on Claude Code, Codex, Gemini CLI, Qwen Code, Devin and OpenCode (where a subagent's edits count as its parent's; re-run `init --agent opencode` once to refresh a plugin generated before 0.6.1); files changed through shell commands are nobody's. A session killed mid-turn never says goodbye: for up to an hour its unfinished files still soften the gate, to one block instead of three, for failures that name none of the remaining session's files. The reverse gap: a live session is invisible to a newcomer until one of its hooks fires after the newcomer's first. Attribution follows where a failure is *reported*, not what caused it: if this session's change breaks a file the other session is still editing, the single block and its question are the only safeguard, and the other session is held to the failure in its file. A file *added* while checks ran, by a session without a post-edit hook or through the shell, cannot be told from the checks' own output, so the receipt can still cover it unseen. A failing test usually names the test file, not the source file that was edited, so such a failure counts as "names none of its files" unless the session also edited the test. `../`-relative paths in check output are not resolved. The release message is shown on Claude Code, Codex, Gemini CLI and Qwen Code; Devin and OpenCode have no channel for one and release silently after the one block. The run lock is best effort: when the wait runs out, or under heavy contention, runs can still overlap, as they always did before. `"otherSessions": "ignore"` switches off the instruction, the single block and the run lock (edits are still recorded; only the receipt binding reads them).

Sharing a directory this way is workable, not ideal: a whole-repo check cannot pass while the other session's half of the tree is broken. For long parallel work, give each session its own [git worktree](https://git-scm.com/docs/git-worktree); each gets its own `.isitdone/` and its own receipt.

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
npx isitdone mcp                  MCP server on stdio for agents without a stop hook (started by the IDE, see "MCP server")
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
  "otherSessions": "respect", // respect (default) | ignore: see "Two sessions in one working tree"
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
- No hook adapter planned: Roo Code and Kilo Code (no hooks), Kiro (its Stop trigger cannot block), Crush (PreToolUse only); they are served by the [MCP server](#mcp-server) instead. Aider has no hooks but `aider --auto-test --test-cmd "npx isitdone"` feeds the same verdict back after every edit.

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
