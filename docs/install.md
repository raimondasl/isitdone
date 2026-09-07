# Installing isitdone (instructions an agent can follow)

You can paste this into your coding agent:

> Install isitdone from https://github.com/raimondasl/isitdone/blob/main/docs/install.md and run its doctor.

## What it is

`isitdone` is a zero-dependency CLI that runs this repository's real test, typecheck and lint commands on the exact working tree, writes a git-bound receipt, and, as a Stop hook, refuses to let a coding agent end its turn claiming "done" while those checks fail. No API keys, no network, no telemetry.

## Steps

1. From the repository root, run:

   ```bash
   npx isitdone init
   ```

   This detects the checks (package.json scripts, pytest/ruff/mypy, go, cargo, .NET, Gradle/Maven, Makefile targets), writes the Stop hook into `.claude/settings.json`, adds `.isitdone/` to `.gitignore`, and runs `doctor`, which proves the hook blocks a synthetic "all tests pass" stop.

2. For other agents, add `--agent`:

   ```bash
   npx isitdone init --agent codex     # .codex/hooks.json (then run /hooks in Codex and trust it)
   npx isitdone init --agent cursor    # .cursor/hooks.json
   npx isitdone init --agent gemini    # .gemini/settings.json
   npx isitdone init --agent copilot   # .github/hooks/isitdone.json (restart Copilot CLI)
   npx isitdone init --agent qwen      # .qwen/settings.json
   npx isitdone init --agent goose     # .agents/plugins/isitdone/hooks/hooks.json
   npx isitdone init --agent droid     # .factory/hooks.json
   npx isitdone init --agent devin     # .devin/hooks.v1.json (skipped when the Claude Code hook exists; Devin loads it)
   npx isitdone init --agent augment   # .augment/settings.json
   npx isitdone init --agent opencode  # .opencode/plugins/isitdone.js (failed checks arrive as a visible [isitdone] follow-up)
   npx isitdone init --agent junie --user   # ~/.junie/config.json (early access; user scope only)
   npx isitdone init --agent all
   ```

3. Confirm the output ends with `OK   the agent cannot claim done with failing checks in this repo`. If `doctor` reports `no checks detected`, add a test script to `package.json` or define checks in `.isitdone.json`:

   ```json
   { "checks": { "test": "make test", "lint": "ruff check ." } }
   ```

4. From now on, before claiming that work is complete, run:

   ```bash
   npx isitdone
   ```

   and paste the output (or `npx isitdone receipt --md`) into your final message.

## Claude Code plugin (alternative to `init`)

```
/plugin marketplace add raimondasl/isitdone
/plugin install isitdone@isitdone
```

The plugin registers the same Stop hook and adds the `isitdone` skill.

## Agent skill

```bash
npx skills add raimondasl/isitdone
```

## Pull requests

Add the GitHub Action to run the same verification on every pull request:

```yaml
- uses: raimondasl/isitdone@v0
```

On a pull request from a fork the default token is read-only, so the sticky comment is skipped; pass a `token` input with write access (a PAT or a GitHub App token) to comment there too. The `json` output is the path of the JSON result (`--json-file`).

## Uninstall

```bash
npx isitdone uninstall
```

Docs: https://github.com/raimondasl/isitdone
