---
name: isitdone
description: Prove a coding task is actually done before saying so. Runs the repository's real test, typecheck and lint commands on the exact working tree, writes a git-bound receipt, and reports NOT DONE with the failing output when anything fails. Use it before claiming "tests pass", before opening a PR, at the end of any task that changed code, or when a user asks you to verify your work.
---

# isitdone

`isitdone` is a zero-dependency CLI that answers one question: **do this repository's own checks pass on the code as it is right now?**
It never guesses. It runs `npm test`, `pytest`, `go test`, `cargo test`, `tsc`, `ruff`, `eslint` (whatever the repo defines) in a subprocess and reads the exit codes.

## When to run it

- Before you write "done", "complete", "all tests pass", "verified", "ready for review", or similar.
- After every change that could affect behaviour, even if you only "fixed a typo".
- When the user asks whether the work is finished or whether tests pass.
- As the last step before creating a commit or pull request.

## How to run it

```bash
npx @aivolution/isitdone
```

- Exit code `0` and a line starting with `DONE` mean every detected check passed on this exact tree, and a receipt was written to `.isitdone/receipt.json`.
- Exit code `1` and `NOT DONE` mean at least one check failed. The output shows which command failed and the last lines of its output.
- If it prints `no checks detected`, tell the user; do not claim the tests pass, because nothing ran.

Machine-readable form for scripts and orchestrators:

```bash
npx @aivolution/isitdone --json      # {"ok": true|false, "done": true|false, "checks": [...]}
```

## What to do with the result

1. **NOT DONE**: fix the underlying problem and run `npx @aivolution/isitdone` again. Do not delete, skip, `.only`, `xit`, or weaken tests, and do not change test configuration or CI settings to make the check pass. If you believe a check is wrong for this repository, say so explicitly to the user instead of working around it.
2. **DONE**: include the receipt in your final message so the user can see the evidence:

```bash
npx @aivolution/isitdone receipt --md
```

Paste that table into your completion message or the PR description.

## Rules

- Never state that tests pass unless `isitdone` (or the equivalent real command) ran on the current tree and returned `DONE`.
- If the checks take too long or time out, report that honestly rather than assuming success.
- `isitdone` is also installed as a Stop hook in many repositories. If your turn is blocked with a message beginning `isitdone: NOT DONE`, treat that message as the ground truth, fix the failures, and only then finish.

## Options you may need

- `npx @aivolution/isitdone --profile lite` runs only fast checks (typecheck, lint). Use it mid-task; use the default full run before claiming completion.
- `npx @aivolution/isitdone detect` shows which commands will run and where they were detected from.
- Repository maintainers can override commands in `.isitdone.json`; do not edit that file to make checks pass.
