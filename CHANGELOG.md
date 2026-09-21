# Changelog

All notable changes to isitdone are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.1] - 2026-09-21

0.6.0 weakened the gate for ordinary single-session use; update with `npx isitdone update`. An adversarial review of 0.6.0 (four reviewers, each finding reproduced by a second agent) confirmed 19 of its 20 findings (several overlapping). This release is the redesign that answers them; a second round of three verifiers re-ran the reproductions against it and found three more serious problems, which are fixed here as well.

### Fixed

- **A conversation that had ended counted as "another live session" for 30 minutes.** After `/clear`, a restart or a new agent process, the previous conversation's uncommitted files were "foreign", so a single user's failing checks were waved through with no block (or one instead of three) and a false "another session is working here" instruction. Another session's files now count as work in progress only with proof: its hooks fired *after this session's first* (within the last hour), and it edited those files *after its own last passing stop*. A predecessor conversation, a session that finished its turn with passing checks (the whole tree, not a pause that ran only lint or nothing), and a one-shot helper that passed and exited, in this project root or another sub-project, all leave the gate exactly as in 0.5.2; regression tests walk these through three blocks.
- **Nothing is released without a block and a fresh run.** 0.6.0 let a stop through unblocked when the failing output named a file of the other session, without checking that it named *only* such files (a passing test file in a verbose listing was enough), and after its single "cannot tell" block it released the next stop without running anything, reporting "still failing" even when the agent had fixed it. Now a failure that names none of this session's files blocks once and asks the agent whether its change caused it; the next stop runs the checks again and only then releases (or passes, or blocks for the session's own files). A block that already carried the other-session instruction counts as the one telling; where a continuation is only inferred (hosts without a continuation flag), a telling older than ten minutes does not.
- **A session that cannot show what it edited gets no leniency.** Hosts without a post-edit hook (Cursor, Copilot CLI, Goose, Droid, Augment, Junie) and sessions that edited only through the shell were never "tied" to their own failures and were released for files they broke themselves, silently on hosts that cannot show a message. They are now gated as if alone, for failing checks and for strict test-integrity findings, and the instruction they get no longer claims the listed files are "not yours" (they may have edited them too).
- **A receipt could vouch for edits no check saw.** A PASS receipt is bound to the tree *after* the run, which includes whatever another session edited while the checks were already running; a stop that waited for that run then found a "cached PASS" for its own unverified edits. A run during which a session recorded an edit, or an existing file was modified or deleted, now binds its receipt to the tree it started on (with a warning); after a lock wait another run's PASS is reused only if that run started on this exact tree; and the Stop hook does not take a cached PASS from a run that began before the session's own latest recorded edit (receipts now carry `startedAt`). What remains: a file *added* during a run by an unrecorded edit cannot be told from the checks' own output.
- **A lite failure in the other session's file hid this session's tests**: the full checks were skipped and the session released with its own tests never run. With a concurrent session the full checks run regardless.
- **OpenCode subagents** recorded edits under the child session id while only the parent is graded, so a session's own subagent looked like another session. The shim now records under the top-level session, and a failed lookup is retried instead of being remembered. Plugins generated before 0.6.1 keep the old behaviour until `npx isitdone init --agent opencode` is run again.
- **Path matching.** A recorded path matched as the tail of any longer path (`utils.js` in `test/utils.js`, `src/index.ts` in `packages/a/src/index.ts`), root-level generic names bypassed the generic-name guard, a bare `handler_test.go:23` matched the wrong package, `a.ts` matched `a.ts.map`, forced colour (`tsc --pretty`, `pytest --color=yes`) glued escape codes to paths, and paths printed relative to a check's `cwd` or a workspace were missed. Matching now resolves the whole path token: repo-relative, absolute under the top-level (also when that path contains spaces), or a shorter tail that exactly one repository file ends with; bare names only when distinctive and unique; ANSI stripped; case-insensitive on Windows and macOS; bounded work on pathological output.
- **Edit records are kept at the repository top-level**, so an edit made while the session's directory was inside a sub-project is no longer invisible to a stop at the top (and no stray `.isitdone/` appears in sub-projects); old record files there are pruned after a day. This session's own records no longer age out after 24 hours, and a long session's record file is compacted.
- **Run lock.** Liveness is a heartbeat (the holder touches the lock every 5 s; 30 s without one means dead, 11 s when its pid is also gone) instead of trusting a pid, which Windows recycles within seconds and containers do not share; the wait uses a monotonic clock and is sized to fit inside the hook timeout that `init` registered (it could previously push a run past it, so the host cancelled the hook and the stop went through unverified); the lock is taken only after the cache check, so a cached PASS never waits; a stale-lock takeover re-checks the token and mtime it judged, and the stop message says when a wait ended that way; Windows `EPERM`/`EBUSY` on create retries instead of abandoning the lock; every wait path honours the deadline; `npx isitdone` and the MCP verify tool take the lock too (the block reason sends agents to the CLI, so hook-only locking serialised very little); `"otherSessions": "ignore"` skips it everywhere.
- The post-edit hook looked up the git top-level three times per call; once now, and the Stop hook no more often than in 0.5.2.

### Changed

- Agent-facing wording states what is known ("another agent session has been working in this same directory while you were", "its last hook activity: 2 min ago") instead of asserting it is working now. The README section "Two sessions in one working tree" is rewritten around the rule "a session on its own is gated as before", lists the limits (a session killed mid-turn, attribution by where a failure is reported, test files versus source files, which hosts can show the release message, a best-effort lock) and no longer calls sharing a directory "safe".

## [0.6.0] - 2026-09-20

### Fixed

- Two agent sessions in one working tree no longer get blamed for each other's work. The checks see the whole tree, so the session that stopped first was blocked for the other session's unfinished files and told to fix them, which invites it to clobber work that is not its own (reported from a repository with two Claude Code sessions). Now the post-edit hook records which session edited which file (`.isitdone/sessions/*.edits`: paths and timestamps, local), and the Stop hook asks whose files a failure names:
  - only files another session (active in the last 30 minutes) has uncommitted edits in: the stop is allowed, the user is told why, and the receipt still says FAIL;
  - this session's files: blocked as before, and the reason opens with the other session's files and the instruction not to edit, revert or "fix" them or run git commands that would discard them;
  - nobody's files (a bare "3 failed"): blocked once instead of `maxAttempts` times;
  - test-integrity findings in the other session's files are not reported as this session's doing and do not block it in strict mode.
  Only positive evidence counts: a dirty file no session recorded, or one left by a session that went quiet, is treated as before. Hosts with a post-edit hook record edits (Claude Code, Codex, Gemini CLI, Qwen Code, Devin, OpenCode); sessions on other hosts still respect what those recorded. `"otherSessions": "ignore"` restores the old behaviour. The README section "Two sessions in one working tree" has the details and recommends a git worktree per session for long parallel work.
- Check runs from the Stop hook are serialised per project (`.isitdone/run.lock`): a second session's stop waits up to three minutes for the run in progress instead of running the suite on top of it (shared caches, build output and ports made both fail for reasons neither change caused), then reuses its PASS receipt when the tree is unchanged. A lock whose holder died, or that is older than 30 minutes, is taken over; when the wait runs out the run goes ahead as before.

### Changed

- The post-edit hook records the edit even when `"integrity": "off"` silences its warning.

## [0.5.2] - 2026-09-20

### Changed

- Claude Code plugin: the hook commands in `hooks/hooks.json` are pinned to the plugin's own npm version (`npx -y @aivolution/isitdone@0.5.2 hook ...`), so a plugin at version X always runs package X (no supply-chain drift, no stale npx cache), and the skill now also ships under `skills/isitdone/SKILL.md`, where plugin discovery looks (the root `SKILL.md` stays for `npx skills add`). Both raised by the buildwithclaude maintainer's review.
- `scripts/sync-server-json.mjs` now syncs every follower of the package version (server.json, the alias package, the plugin manifests, the pinned hook commands) and the skill copy; its `--check` mode runs in the test suite.

## [0.5.1] - 2026-09-19

### Fixed

- Python detection no longer guesses `mypy .` (or `ruff check .`, bare `pytest`) when the repository says otherwise. The order is now: the command a GitHub workflow runs (`mypy src/pkg`, `ruff check src tests`, pytest paths and `-m`/`-k` selection; a line with shell syntax or `${{ }}` is never copied), then the mypy configuration's own `files`/`packages`/`modules` (bare `mypy`), then `mypy src` for a src layout, and `mypy .` only as the last resort. `isitdone detect` shows the workflow file as the source. A wrong guess made every stop report NOT DONE until a `.isitdone.json` was written.

## [0.5.0] - 2026-09-19

### Added

- `isitdone mcp`: a Model Context Protocol server on stdio for agents and IDEs that have no blocking stop hook (VS Code Copilot agent mode, Cline, Windsurf Cascade, Kiro, Zed, JetBrains, Claude Desktop, Amp, Crush). Three tools: `isitdone_verify` (`cwd`, `profile`, `claim`, `base`, `strict`; the same run as the CLI, returning `done`, per-check status, the failing output tail, the test-integrity findings and the receipt state; NOT DONE is a result, `isError` stays false), `isitdone_receipt` (PASS | FAIL | STALE | NONE for the current tree) and `isitdone_detect` (which checks would run). Every tool returns a text report, plus `structuredContent` with an `outputSchema` where the negotiated revision has them. The server instructions tell the model to verify before claiming completion, to paste the result, and never to weaken tests. Written against the wire format (newline-delimited JSON-RPC 2.0), so the package still has no dependencies. A tool the model chooses to call is weaker than a hook the host enforces: hosts with a hook should keep using it.
- MCP protocol coverage: the handshake revisions 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25 (version negotiation, `ping`, tool shapes trimmed to what each revision knows, workspace roots through `roots/list`) and the stateless 2026-07-28 revision (`server/discover`, per-request `_meta` with `UnsupportedProtocolVersionError`, `resultType`, `ttlMs`/`cacheScope`, roots through an `input_required` result). Unknown methods answer -32601, malformed JSON -32700, and notifications are never answered.
- MCP behaviour under load: one verification at a time per repository, and an identical concurrent call gets the result of the run in flight; a `notifications/cancelled` (a client-side tool timeout) drops the answer but lets the run finish and write its receipt, so the retry is immediate; progress notifications per check for requests that carry a `progressToken`; when stdin closes, the running check's process tree is killed, no receipt is written, and the server exits. `ISITDONE=1` makes `isitdone_verify` refuse, as the CLI does. Nothing a check prints can reach the protocol stream.
- `server.json` for the official MCP Registry (`io.github.raimondasl/isitdone`, npm package `@aivolution/isitdone`, stdio, `npx ... mcp`) and the `mcpName` field in `package.json` that the registry uses to verify npm ownership. The release workflow publishes it after npm with `mcp-publisher login github-oidc` (no secret); a registry outage produces a warning, never a failed release. `node scripts/sync-server-json.mjs` keeps its version on `package.json` (`--check` runs in the test suite).
- `verify()` and `runCheck()` accept an `AbortSignal`: the running check is killed, the rest are skipped, and no receipt is written.

### Fixed

- A lite run that reuses a lite PASS receipt printed `DONE`; it now prints `OK (lite)`, like the run that wrote the receipt (`--json` already said `done: false`).
- Scanner: `expect(`${a}-${b}`)` is no longer reported as an assertion on a constant (an interpolated template literal only looks empty once strings are blanked).

### Documentation

- `docs/agent-hooks.md`: a vendor-neutral reference for end-of-turn hooks across the twelve supported agents (config files, payloads, how to block, loop flags, timeouts, post-edit channels), the agents without a usable gate and their nearest alternative, and the rules a portable stop hook should follow. `docs/agent-hooks.json` carries the comparison table as data; a test pins both to `src/hosts.ts`.
- `docs/why.md`: the long-form case for a gate at the moment of the claim.

## [0.4.2] - 2026-09-11

### Fixed

- `history` (Qwen Code): a `/rewind` leaves the truncated branch in the session file; only the live `parentUuid` chain is graded now, so rewound claims no longer count.
- `history` (Cursor): a composer whose workspace cannot be resolved is left to its JSONL transcript, where `--exclude` can match the project slug, instead of being scanned from the bubble store under an unmatchable label.
- `init`: installing the Claude Code hook next to a native Devin entry now says so (Devin loads both).

### Added

- Issue templates for host hook reports, scanner mistakes and bugs; GitHub Discussions enabled.
- `history`: every claim records `testFails`, the number of failed test runs in its turn. A VERIFIED claim whose turn also had a failure is called out in the summary and marked in `--verbose` ("after 1 failed run"), since the run that passed last may have been a narrower command than the one that failed (reported by Kevin Lozada Santos in openai/codex#44153).

## [0.4.1] - 2026-09-09

### Changed

- Action description shortened to the Marketplace limit (125 characters); no functional change.

## [0.4.0] - 2026-09-07

### Added

- Eight more hosts: GitHub Copilot CLI (`agentStop` in `.github/hooks/isitdone.json`), Qwen Code (`.qwen/settings.json`, Stop + PostToolUse), Goose (`.agents/plugins/isitdone/hooks/hooks.json`), Factory Droid (`.factory/hooks.json`), Devin (`.devin/hooks.v1.json`, Stop + PostToolUse; skipped when the Claude Code hook is present because Devin loads it too), Augment/Auggie (`.augment/settings.json`, block nested under `hookSpecificOutput`), OpenCode (a zero-dependency plugin at `.opencode/plugins/isitdone.js`: OpenCode has no blocking hook, so on `session.idle` the plugin runs the checks and, on failure, sends the reason back as a visible `[isitdone]` follow-up message; `tool.execute.after` carries the mid-turn warning) and Junie CLI (early access, `~/.junie/config.json`, user scope only). `init --agent all|auto`, `doctor` probes, receipts and per-session state cover them; hosts without a continuation flag get isitdone's own attempt counter. The Claude Code registration is also loaded by Devin and Continue (`cn`).
- `isitdone history` reads Gemini CLI (`~/.gemini/tmp/<project>/chats`, `.json` and 0.39+ `.jsonl` with in-place record replacement, `$set` and `$rewindTo`), Qwen Code (`~/.qwen/projects/<cwd>/chats/*.jsonl`) and Cursor (the IDE's `state.vscdb` via `node:sqlite` on Node 22.13+/24, read-only in place; otherwise the `agent-transcripts` JSONL, whose sessions carry no exit codes and are reported as lossy) next to Claude Code and Codex; one line per agent in the report; `--exclude` and `history.exclude` apply to every source. Codex pre-0.40 rollouts are parsed and `thread_rolled_back` drops the undone turns.
- Test-integrity scanner: Rust (cargo test/nextest; `#[test]`, `#[tokio::test]`, rstest, test_case; `#[ignore]` and `#[cfg_attr(_, ignore)]` tiers; `#[should_panic(expected)]` loosened; `assert*!`, `.unwrap()`, `?` and `panic!` as assertions; inline `#[cfg(test)]` modules in `src/` found by a bounded content sniff and scanned only inside the gated region), Java and Kotlin (JUnit 4/5, TestNG, AssertJ, Hamcrest, Mockito; `@Disabled`/`@Ignore`/`assumeTrue(false)`/`@EnabledIf*` tiers; `@CsvSource` rows counted; a rename away from a Surefire/Failsafe name is an effective deletion; Kotlin is best effort for JUnit/kotlin.test), C# (xUnit, NUnit, MSTest, FluentAssertions; `Skip =`/`[Ignore]`/`[Explicit]`/`Assume.That`; `[InlineData]`/`[TestCase]`/`[DataRow]` rows counted; `Assert.Pass` as an early return). New configuration files: Cargo.toml, .cargo/config, nextest.toml, justfile, Taskfile.yml, pom.xml, build/settings.gradle(.kts), gradle.properties, .mvn/maven.config, testng.xml, junit-platform.properties, *.csproj, Directory.Build.props, *.runsettings, xunit.runner.json, and more CI files; command patterns such as `cargo test -- --skip`, `-DskipTests`, `-Dmaven.test.failure.ignore`, `gradle -x test`, `dotnet test --filter`. Bench corpus: 170 cases, 100% precision.
- `npm run demo` renders the README's animated terminal demo from a real run (`docs/demo.svg`).

### Changed

- `stop_hook_active` may be absent: the hook then counts consecutive blocks itself and resets when it gives up.
- `history --json` reports `byAgent.<name>` for every source and marks claims without exit codes as `lossy`.
- The GitHub Action is listed as `isitdone verify` (the Marketplace forbids a name that matches an existing GitHub user); `uses: raimondasl/isitdone@v0` is unchanged.
- Augment: Auggie runs script files, so `init` writes `.augment/hooks/isitdone-hook.sh` and `.cmd` and registers the wrapper path instead of a command line.
- Review fixes before release: the OpenCode plugin re-prompts under the session's own agent and model, ignores shell runs and synthetic messages, and never runs two checks for one session at once; Codex rollouts using the v1 `task_started`/`task_complete` names delimit turns once per prompt (so `/undo` retracts the right turn); a Cursor bubble-store query error falls back to the transcripts; Gemini `$rewindTo` with an unknown id drops nothing; `uninstall` deletes an emptied Droid or Copilot hooks file and works for Junie without `--user`; `init --agent all` reports a foreign OpenCode plugin file as skipped instead of aborting; an installed Devin hook is `unchanged`, not `skipped`. Scanner precision: `cargo test --no-run` next to a real `cargo test` step is low; a pom.xml `<exclude>` inside a non-test plugin (shade, resources) is low; a two-argument `Assert.Equal` is not a precision change; an ungated `#[test]` in a Rust source file no longer turns the production code around it into test code; a fluent chain that gains `isNotNull()` on the same line is not a downgrade; Kotlin backtick test names keep their identity.

## [0.3.0] - 2026-09-07

### Added

- Warn-only post-edit hook (`hook --host <name> --event edit`): after every file edit on Claude Code (`PostToolUse`, `Edit|Write|MultiEdit`), Codex (`PostToolUse`, `apply_patch` patch text parsed for file names) and Gemini CLI (`AfterTool`, `write_file|replace`), the edited test or configuration file is scanned against HEAD and a short factual note is added to the agent's context when the edit weakened a test. Never blocks. `init` registers it next to the Stop hook (`--no-edit-hook` to skip); Cursor has no agent-visible channel after an edit and keeps the Stop-hook scan only.
- GitHub Action (`uses: raimondasl/isitdone@v0`): runs the checks and the test-integrity scan against the PR merge-base from a clean checkout (never trusts a receipt), writes the receipt to the job summary, keeps one updated PR comment (skipped gracefully on fork PRs or without `pull-requests: write`), optional SARIF upload, strict by default.
- `isitdone history` reads Codex CLI rollouts (`$CODEX_HOME/sessions` in the dated and flat layouts, `archived_sessions`, zstd-compressed files where Node can decompress them), both the legacy and the paginated history modes; reports per agent.
- Submodules and embedded repositories are part of the working-tree hash, so edits inside them invalidate receipts.
- `--report <file>` (markdown report), `--sarif <file>` (SARIF 2.1.0) and `--json-file <file>` on `run`.
- `bench/`: a labelled corpus of 118 legitimate refactors and tampering cases with `npm run bench` printing precision and recall per language; new detectors it demanded (dropped table rows, constant assertion targets, `expect.assertions(0)`, plain `assert x == v` downgrades, unittest first-argument subjects, returns behind an `if`, docstring openers, multi-line ignore lists, JSON-escaped `-t` quotes).
- Programmatic API: `import { verify, scanIntegrity, checkEditedFile, toSarif } from '@aivolution/isitdone'` (`dist/index.js`).

### Changed

- The block reason ends with `[isitdone x.y.z]` (used by `doctor` to report the running hook version).
- `continue-on-error` on a CI step that does not run tests is low, not critical.
- `isitdone history` (Codex): the freeform shell header `Exit code: N` is parsed; a command still running after Codex's yield window is followed through the `write_stdin` polls that carry its real exit code instead of counting as a pass; a declined command is not a test run; a `turn_aborted` line from a build that persisted no other turn events no longer merges the rest of the session into one turn; edits and commands written both as `response_item` and as `item_completed`/`patch_apply_end` are counted once; `grep "=>"`, `cat src/patch.ts` and `>/dev/null` are not edits; `isitdone doctor|init|history|...` are not test runs.
- Post-edit hook: honours `"integrity": "off"`; resolves Codex's cwd-relative `apply_patch` paths against the session cwd; diffs the working tree once per hook run; a rename with edits is reported once under the new name; the note says what it measures (uncommitted changes vs HEAD, not only this edit); a file on another Windows drive is outside the repo; Gemini no longer sees `-&gt;`. A custom `--command` wrapper that does not forward `--event edit` gets its tool events handled as the warn-only edit hook instead of running the checks.
- Working-tree hash: a submodule that is not initialised or whose directory is missing contributes its recorded commit instead of recursing forever (uninitialised) or making the whole hash unknown (missing).
- `--base <ref>` that does not resolve is an error (integrity scan skipped with a warning) instead of "every file is new". The Action verifies each fallback base commit before using it, accepts a sha, tag or qualified ref as `base`, warns when it falls back, finds its sticky comment by marker (so a PAT or App token updates instead of duplicating), comments on `pull_request_target` and on fork PRs when a write token is supplied, and its `json` output now points at a file that exists.

## [0.2.1] - 2026-09-07

### Added

- `isitdone update`: npx keeps its own install cache (`_npx/`) that `npm cache clean` does not touch, so an unpinned `npx -y @aivolution/isitdone hook ...` could keep running the first version it cached. `update` removes those entries for both packages and re-warms them at the registry's latest; `--check` only reports whether a newer release exists.
- `doctor` now reports which isitdone version the installed hook actually runs (the block reason carries `[isitdone x.y.z]`), flags a hook older than the CLI, and mentions a newer release when the registry is reachable (`--no-latest` skips the lookup).
- README "Updating" section.

## [0.2.0] - 2026-09-07

### Added

- Test-integrity scan of the change set (working tree vs HEAD, or `--base <ref>`): deleted test files, new `.skip`/`.only`/`xfail`/`t.Skip`, dropped tests and assertions, weakened matchers (`toStrictEqual` to `toEqual`, `toThrow("msg")` to `toThrow()`, `toHaveBeenCalledWith` to `toHaveBeenCalled`, `assertEqual` to `assertTrue`, `pytest.raises(Specific)` to `raises(Exception)`, `assert.Equal` to `NotNil`), widened tolerances, empty `catch` / `except: pass`, neutered configuration (`|| true`, `--passWithNoTests`, `continue-on-error`, `if: false`, `testPathIgnorePatterns`, pytest `--ignore`/`--deselect`, removed CI test steps, deleted workflows), and snapshot rewrites. JS/TS, Python, Go. Before/after summary line, evidence per finding, findings recorded in the receipt and shown in the PR markdown.
- `"integrity": "warn" | "strict" | "off"` in `.isitdone.json`; `--strict` / `--ci` on the CLI. In strict mode unsuppressed high/critical findings block the stop even when the checks pass. Inline `// isitdone: allow <reason>` suppressions are reported, never hidden; `--ci` counts new suppressions as findings.
- `isitdone history [--since] [--exclude] [--verbose] [--min] [--json] [--include-subagents]`: scans local Claude Code transcripts and reports what share of past completion claims had a passing test run after the last edit (VERIFIED / STALE / FAILED / NEVER RAN), per project. Local only.
- Claude Code plugin: `/plugin marketplace add raimondasl/isitdone`, `/plugin install isitdone@isitdone` (Stop hook plus the skill); `docs/install.md` for paste-to-agent installs.
- `isitdone` alias package now depends on `@aivolution/isitdone@*`, so it always resolves the latest release.
- Detector precision, from a 200-case hunt of legitimate refactors and tampering: `it.each`/`test.each` rows and their assertions are counted, tests moved to another file in the same diff and unstaged whole-file renames are not deletions, assertions extracted into a helper or wrapped in a loop and callback-to-async conversions are low, a re-indented strong assertion is not a downgrade, `test.todo` is low unless it replaces a real test, block comments and docstrings are ignored, commented-out assertions no longer count, non-ASCII test names count, Go `t.Run` subtests and testify pairing work. New detectors: tautologies (`expect(true).toBe(true)`, `assert True`), early `return` before assertions, Go `recover()` in tests, `--testPathPattern`/`-run`/`-short`/mocha `spec` narrowing, `if: "false"`, `continue-on-error: ${{ ... }}`, `; exit 0` inside JSON scripts, test-to-lint step swaps; benign `|| true` on non-test scripts, default ignore lists, widened `testMatch`, `-p no:cacheprovider` and YAML comments stay quiet. Tolerance severity now scales with the loss.

### Changed

- The block reason distinguishes a TIMEOUT from a failure and, when only the integrity scan blocks, says so instead of "checks failed".
- `--json` gains `integrity` and `noChecks`; `done` is false when no checks were detected.

## [0.1.0] - 2026-09-07

First release.

### Added

- `npx isitdone`: detects the repository's test, typecheck, lint and build commands (npm/pnpm/yarn/bun/deno scripts, pytest/ruff/mypy/pyright/flake8, `go vet`/`go test`, `cargo check`/`cargo test`, .NET, Gradle/Maven, Makefile targets), runs them in a subprocess with timeouts, prints PASS/FAIL per check with the failing output tail, and exits 0 or 1.
- Receipts: `.isitdone/receipt.json` bound to a hash of the exact working tree (tracked changes and untracked files, via a temporary git index), the check configuration, and an HMAC key. `isitdone receipt` reports PASS, FAIL, STALE (files changed since) or NONE; `--md` prints a table for PR bodies; `--json` is a done-predicate for scripts.
- Stop hook for Claude Code, Codex CLI, Cursor and Gemini CLI (`isitdone hook --host <name>`): reads the host payload from stdin, claim-gates the expensive checks on the agent's final message, caches PASS receipts per tree, cooperates with each host's loop protection, caps consecutive blocks (`maxAttempts`, default 3), and never breaks the agent on malformed input or internal errors.
- `isitdone init`: idempotently writes the hook into `.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json` or `.gemini/settings.json` (project scope by default, `--user` for user scope), adds `.isitdone/` to `.gitignore`, and runs `doctor`.
- `isitdone doctor`: pipes a synthetic "all tests pass" stop event through every installed hook and proves it blocks; reports detected checks, git state and host-specific trust steps.
- `.isitdone.json` / `package.json#isitdone` configuration: override or disable checks, add custom ones, set profile (`claim-gated`, `lite`, `full`), timeouts, `maxAttempts`, extra claim patterns.
- `SKILL.md` so agents can install the behaviour with `npx skills add raimondasl/isitdone`.
- Published as `@aivolution/isitdone`, with `isitdone` on npm as a short alias exposing the same command.
