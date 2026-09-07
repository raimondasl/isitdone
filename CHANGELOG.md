# Changelog

All notable changes to isitdone are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
