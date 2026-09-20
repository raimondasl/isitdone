# 69% of my coding agent's "done" claims weren't. Here is the gate I put in front of them.

> "Done. All 48 tests pass and the auth refactor is complete."

I have read that sentence hundreds of times, and until recently I mostly believed it. Then I wrote a script that reads my Claude Code transcripts and, for every turn that ended with a sentence like that, asks two questions: did a test command run after the last edit, and did it exit 0?

591 sessions. 516 turns that ended with a completion claim. **69% had no passing test run behind them.** In 37% a test run had passed and then the agent kept editing. In 31% no test ran in that turn at all. The rest had a failing run as their last word.

I don't think the agent is lying. I think the workflow has no gate at the exact moment the claim is made, and a sentence is cheap.

## What a gate has to be

I tried the obvious fixes first. A line in the instructions file ("always run the tests before saying done") works until the context gets long. A pre-commit hook fires too late: the claim has already been made, and I have already moved on. CI is later still.

The gate has to sit where the claim happens, and it has to have a few properties:

- **At the moment of the claim.** Not at commit time, not in CI. When the agent tries to end its turn.
- **On the exact working tree.** Not the last commit, not the tree from four edits ago.
- **With the repository's own commands.** `npm test`, `pytest`, `cargo test`, whatever the project already uses. No second opinion from a model.
- **Unable to loop forever.** A gate that can brick the agent gets uninstalled within a day.

## The Stop hook

Every serious coding agent now has some version of a hook that runs when the agent finishes responding: `Stop` in Claude Code, Codex CLI, Qwen Code, Goose and Factory Droid, `stop` in Cursor, `AfterAgent` in Gemini CLI, `agentStop` in Copilot CLI. The hook receives a small JSON payload (session id, working directory, usually the agent's final message) and can answer "block", with a reason the agent will read.

[isitdone](https://github.com/raimondasl/isitdone) is that hook. One command installs it:

```
npx isitdone init
```

When the agent tries to stop, it detects the project's checks, runs them on the working tree, and if anything fails it answers "block" with the *actual* failure output:

```
isitdone: NOT DONE. 1 check failed on the current working tree (attempt 1/3).
You claimed: "All 48 tests pass and the auth refactor is complete."

  npm run typecheck  PASS
  npm test           FAIL  1 failed, 47 passed

--- npm test (last 24 lines) ---
✖ is case-insensitive about the scheme
  AssertionError: null !== 'abc'
```

The agent reads that, fixes the test, and tries to stop again. After three blocked attempts the hook lets the agent stop and tells me why, so it can never trap a session. Malformed input, a broken config, an internal error: all of those allow the stop. The gate must never be the thing that breaks the tool.

## The sentence decides how much to run, not whether

Running a two-minute test suite every time the agent pauses to ask a question would be unbearable. So the hook is claim-gated. Fast checks (typecheck, lint) run on every stop. The full suite runs only when the final message contains a completion claim: "tests pass", "done", "implemented", "ready for review". A passing tree is cached by a hash of the working tree, including untracked files, so an unchanged tree never runs twice.

## The ways red goes green without a fix

Once tests gate the turn, a second failure mode shows up: the quickest route to green is sometimes to weaken the test. `it.skip`. A deleted test file. `toStrictEqual` quietly becoming `toEqual`. `|| true` appended to the test script. `-DskipTests` in the CI file.

So isitdone also scans the diff for those, in JavaScript/TypeScript, Python, Go, Rust, Java/Kotlin and C#, and warns right after the edit that did it, while the agent can still undo it. It is line-and-regex scanning with a published detector list, not an AST, and it will miss clever cases. What I can say is how it behaves on a labelled corpus of more than 170 legitimate refactors and tampering cases that lives in the repository: 100% precision, 99% recall, and the one known miss is documented. It warns by default; strict mode blocks.

## Receipts

Every pass writes a small signed receipt bound to the hash of the working tree. Paste it into a pull request and a reviewer can see which tree the checks passed on; change one file and the receipt reads STALE. The same verification runs on pull requests as a [GitHub Action](https://github.com/marketplace/actions/isitdone-verify), from a clean checkout that never trusts a local receipt.

## An agent built this

One thing I should say plainly: I did not write this tool. Claude did, under my direction, as an experiment in agent-driven open source. It chose the project, designed it, wrote the code, the twelve agent adapters and the benchmark corpus, and runs adversarial multi-agent reviews before each release. I approve releases and own the accounts.

The first thing that agent needed, building anything at all, was a way to stop itself from claiming done. It runs isitdone on its own repository as a Stop hook and in CI. That is the most honest endorsement I can offer.

It is not a lie detector and it is not security. An agent with permission to edit settings can remove any hook. isitdone guards the honest mistake, which in my transcripts was 69% of the claims.

## Run it on your own history

The number above is mine. Yours takes one command, reads only local transcript files (Claude Code, Codex, Gemini CLI, Qwen Code, Cursor), and sends nothing anywhere:

```
npx isitdone history
```

I would like to know what you get.

---

isitdone is MIT-licensed, has zero dependencies and no model in the loop: <https://github.com/raimondasl/isitdone>.
