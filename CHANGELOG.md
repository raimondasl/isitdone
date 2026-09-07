# Changelog

All notable changes to isitdone are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-07

### Added

- Test-integrity scan of the change set (working tree vs HEAD, or `--base <ref>`): deleted test files, new `.skip`/`.only`/`xfail`/`t.Skip`, dropped tests and assertions, weakened matchers (`toStrictEqual` to `toEqual`, `toThrow("msg")` to `toThrow()`, `toHaveBeenCalledWith` to `toHaveBeenCalled`, `assertEqual` to `assertTrue`, `pytest.raises(Specific)` to `raises(Exception)`, `assert.Equal` to `NotNil`), widened tolerances, empty `catch` / `except: pass`, neutered configuration (`|| true`, `--passWithNoTests`, `continue-on-error`, `if: false`, `testPathIgnorePatterns`, pytest `--ignore`/`--deselect`, removed CI test steps, deleted workflows), and snapshot rewrites. JS/TS, Python, Go. Before/after summary line, evidence per finding, findings recorded in the receipt and shown in the PR markdown.
- `"integrity": "warn" | "strict" | "off"` in `.isitdone.json`; `--strict` / `--ci` on the CLI. In strict mode unsuppressed high/critical findings block the stop even when the checks pass. Inline `// isitdone: allow <reason>` suppressions are reported, never hidden; `--ci` counts new suppressions as findings.
- `isitdone history [--since] [--exclude] [--verbose] [--min] [--json] [--include-subagents]`: scans local Claude Code transcripts and reports what share of past completion claims had a passing test run after the last edit (VERIFIED / STALE / FAILED / NEVER RAN), per project. Local only.
- Claude Code plugin: `/plugin marketplace add raimondasl/isitdone`, `/plugin install isitdone@isitdone` (Stop hook plus the skill); `docs/install.md` for paste-to-agent installs.
- `isitdone` alias package now depends on `@aivolution/isitdone@*`, so it always resolves the latest release.

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
