# End-of-turn hooks across coding agents

A reference for the hook that runs when a coding agent finishes its turn: the `Stop` hook in Claude Code, Codex CLI, Qwen Code, Goose, Factory Droid, Devin, Augment and Junie CLI, `stop` in Cursor, `AfterAgent` in Gemini CLI, `agentStop` in GitHub Copilot CLI, and a plugin on `session.idle` in OpenCode. For each agent it gives the config file, a minimal working entry, the stdin payload, the exact stdout that blocks and that allows, the loop protection, and the traps.

The use case throughout is a gate: a command (`my-check.sh` below) that refuses to let the agent stop while something is still wrong, and hands the agent the reason.

- Machine-readable version of the comparison table: [`agent-hooks.json`](agent-hooks.json) (one object per agent). A test in this repository fails when it drifts from the adapters in `src/hosts.ts`.
- Every section ends with a `Checked:` line. "Verified" means the vendor page stated it on that date. "Unverified" means it comes from reading the agent's source or from local observation, and the vendor page did not confirm it.
- Corrections are welcome: open an issue with the agent version and the payload you saw.

## Comparison

| Agent | Config file (project / user) | Event | Can it block? | How | Gets the final message? | Continuation flag | Timeout unit, default | Post-edit event with an agent-visible channel |
|---|---|---|---|---|---|---|---|---|
| Claude Code | `.claude/settings.json` / `~/.claude/settings.json` | `Stop` | yes, veto | stdout JSON `decision: "block"`, or exit 2 + stderr | yes, `last_assistant_message` | `stop_hook_active`; agent caps at 8 | seconds, 600 | `PostToolUse` → `hookSpecificOutput.additionalContext` |
| Codex CLI | `.codex/hooks.json` / `~/.codex/hooks.json` | `Stop` | yes, veto | stdout JSON `decision: "block"`, or exit 2 + stderr | yes, `last_assistant_message` | `stop_hook_active` | seconds, 600 | `PostToolUse` → `hookSpecificOutput.additionalContext` |
| Cursor | `.cursor/hooks.json` / `~/.cursor/hooks.json` | `stop` | follow-up only | stdout JSON `followup_message` | no | `loop_count` (per conversation); `loop_limit` default 5 | seconds, "platform default" | `postToolUse` → `additional_context` |
| Gemini CLI | `.gemini/settings.json` / `~/.gemini/settings.json` | `AfterAgent` | yes, veto (retry) | stdout JSON `decision: "deny"`, or exit 2 + stderr | yes, `prompt_response` | `stop_hook_active` | **milliseconds**, 60000 | `AfterTool` → `hookSpecificOutput.additionalContext` |
| GitHub Copilot CLI | `.github/hooks/<name>.json` / `~/.copilot/hooks/<name>.json` | `agentStop` | yes, veto | stdout JSON `decision: "block"` (exit 2 is only a warning) | no (`transcriptPath` only) | `stop_hook_active`; agent caps at 8 | seconds (`timeoutSec`), **30** | `postToolUse` → `additionalContext` |
| Qwen Code | `.qwen/settings.json` / `~/.qwen/settings.json` | `Stop` | yes, veto | stdout JSON `decision: "block"`, or exit 2 | yes, `last_assistant_message` | `stop_hook_active`; agent caps at 8 | seconds, 60 (a value ≥ 1000 is read as ms) | `PostToolUse` → `hookSpecificOutput.additionalContext` |
| Goose | `.agents/plugins/<name>/hooks/hooks.json` / `~/.agents/plugins/<name>/hooks/hooks.json` | `Stop` | yes, veto | stdout JSON `decision: "block"`, or exit 2 + stderr | yes, `last_assistant_message` | none; agent caps consecutive blocks | seconds, 30 | none (`PostToolUse`, `AfterFileEdit` observe only) |
| Factory Droid | `.factory/hooks.json` / `~/.factory/hooks.json` | `Stop` | yes, veto | stdout JSON `decision: "block"`, or exit 2 + stderr | no | `stop_hook_active` | seconds, 60 | `PostToolUse` → `hookSpecificOutput.additionalContext` |
| Devin (CLI and Local) | `.devin/hooks.v1.json` / `~/.config/devin/config.json` (`%APPDATA%\devin\config.json`) | `Stop` | yes, veto | stdout JSON `decision: "block"` (exit 2 per the generic exit-code table) | no | `stop_hook_active` | seconds, not documented | `PostToolUse` → `hookSpecificOutput.additionalContext` |
| Augment (Auggie CLI) | `.augment/settings.json` / `~/.augment/settings.json` | `Stop` | yes, veto | stdout JSON, nested: `hookSpecificOutput.decision: "block"` (exit 2 does not block) | opt-in, `conversation.agentTextResponse` | none | **milliseconds**, 60000 | `PostToolUse` → `hookSpecificOutput.additionalContext` |
| OpenCode | `.opencode/plugins/<name>.js` / `~/.config/opencode/plugins/<name>.js` | `session.idle` (plugin event) | follow-up only | plugin calls `client.session.promptAsync` | yes, through the SDK | none | the plugin's own | `tool.execute.after` → append to `output.output` |
| Junie CLI (early access) | user only: `~/.junie/config.json` | `Stop` | yes, veto | stdout JSON `decision: "block"`, or exit 2 + stderr | yes, `last_assistant_message` | `stop_hook_active`; agent caps at 8 | seconds, 600 for `Stop` | none (no post-tool event) |

Two kinds of "block" appear in the table. A **veto** keeps the turn open: the agent receives the reason and continues the same turn. A **follow-up** lets the turn end and submits the hook's text as the next user message. Both keep the agent working; the difference matters for loop counting and for non-interactive runs, where the process may exit before a follow-up is applied.

Unless a section says otherwise, the payload arrives as one JSON object on stdin, the hook answers on stdout with exit code 0, and a hook that crashes, times out or prints something unparsable lets the agent stop (fail-open).

## Claude Code: `Stop`

`.claude/settings.json` (project, committed), `.claude/settings.local.json` (project, not committed) or `~/.claude/settings.json` (user):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/my-check.sh", "timeout": 600 }] }
    ]
  }
}
```

Stdin:

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf.jsonl",
  "cwd": "/work/app",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "Done. All tests pass.",
  "background_tasks": [],
  "session_crons": []
}
```

| Field | Meaning |
|---|---|
| `session_id`, `prompt_id` | Session and user-prompt identifiers. |
| `cwd` | The session's current directory; it can be a subdirectory of the repository. |
| `permission_mode` | `default`, `plan`, `acceptEdits`, `auto`, `dontAsk` or `bypassPermissions`. In `plan` the agent cannot edit files. |
| `stop_hook_active` | `true` when Claude Code is already continuing because a Stop hook blocked. |
| `last_assistant_message` | Text of the final response. Prefer it to `transcript_path`: the transcript is written asynchronously and may lag. |
| `background_tasks`, `session_crons` | In-flight background work and scheduled wake-ups. Non-empty means the stop may be a pause, not an end. |

Block (exit 0):

```json
{ "decision": "block", "reason": "npm test fails: 1 failed, 3 passed. Fix it before finishing." }
```

Exit code 2 with the reason on stderr does the same. Allow: exit 0 with empty stdout; `{"systemMessage": "..."}` allows and shows the user a note. A second channel, `{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "..."}}`, also continues the turn but is labelled hook feedback instead of a hook error.

Loop safety: check `stop_hook_active`. Claude Code ends the turn after 8 consecutive blocks regardless of the hook.

Gotchas:

- `Stop` has no matcher; it fires on every stop except a user interrupt. API errors fire `StopFailure` instead.
- `additionalContext`, `systemMessage` and plain stdout are capped at 10,000 characters each; longer text is replaced by a file path and a 2,000-character preview. Keep a block reason well below that.
- Stdout must be the JSON object only. A shell profile that prints on startup breaks parsing.
- The same file is read by other agents: Cursor (third-party imports, on by default), Devin, Copilot CLI, and Continue's `cn`. A gate registered here and again in their native files runs twice.
- Post-edit channel: `PostToolUse` with matcher `Edit|Write|MultiEdit`; `hookSpecificOutput.additionalContext` lands next to the tool result.

Docs: https://code.claude.com/docs/en/hooks

Checked: 2026-09-19. Verified: file locations, entry shape, timeout unit and default, payload fields, `decision`/`reason`, exit 2, no matcher, the cap of 8, the 10,000-character cap, both `additionalContext` channels. Unverified: that Continue (`cn`) sends `stop_hook_active: true` on every stop, so the flag carries no information there (from Continue's source, not from a vendor page).

## Codex CLI: `Stop` in `hooks.json`

`<repo>/.codex/hooks.json` or `~/.codex/hooks.json`; the same structure can be written as inline `[hooks]` tables in `.codex/config.toml`.

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"$(git rev-parse --show-toplevel)\"/my-check.sh", "timeout": 600 }] }
    ]
  }
}
```

Stdin:

```json
{
  "session_id": "0198...",
  "turn_id": "turn-7",
  "transcript_path": null,
  "cwd": "/work/app",
  "hook_event_name": "Stop",
  "model": "...",
  "permission_mode": "default",
  "stop_hook_active": false,
  "last_assistant_message": "Done. All tests pass."
}
```

| Field | Meaning |
|---|---|
| `turn_id` | Codex extension: the active turn. |
| `transcript_path` | May be `null`; the transcript format is not a stable interface. |
| `permission_mode` | `default`, `acceptEdits`, `plan`, `dontAsk` or `bypassPermissions`. |
| `stop_hook_active` | Whether this turn was already continued by `Stop`. |
| `last_assistant_message` | Latest assistant text, or `null`. |

Block (exit 0): `{"decision": "block", "reason": "..."}`, or exit 2 with the reason on stderr. Codex turns `reason` into a new continuation prompt. Allow: exit 0 with empty stdout. `{"continue": false}` from any Stop hook ends the turn and wins over a block from another hook.

Loop safety: `stop_hook_active`. No cap on consecutive blocks is documented, so the hook must bring its own.

Gotchas:

- **Hook trust.** A new or changed hook is skipped until it is reviewed: run `/hooks` inside Codex and trust it. Trust is recorded against a hash of the definition, so editing the command means trusting it again. Project hooks load only when the project's `.codex/` layer is trusted. `--dangerously-bypass-hook-trust` skips the check for one invocation.
- **Strict output.** `Stop` expects JSON on stdout when it exits 0; plain text is invalid for this event. Fields the event does not support mark the hook run as failed.
- **No BOM.** Write `hooks.json` as UTF-8 without a byte-order mark.
- `matcher` is ignored for `Stop`.
- Commands run with the session `cwd`, which may be a subdirectory; resolve scripts from the git root as above. `commandWindows` overrides the command on Windows.
- Hooks are on by default; `[features] hooks = false` in `config.toml` turns them off.
- Post-edit channel: `PostToolUse`. File edits arrive as `tool_name: "apply_patch"` with the patch text in `tool_input.command`; the matcher accepts `apply_patch`, `Edit` or `Write`. `hookSpecificOutput.additionalContext` is added as developer context (default limit about 2,500 tokens, `additionalContextLimit` to change it).

Docs: https://learn.chatgpt.com/docs/hooks (`developers.openai.com/codex/hooks` redirects there)

Checked: 2026-09-19. Verified: file locations, trust review and hash, shape, timeout unit and default, payload fields, block and allow output, `reason` as continuation prompt, matcher ignored, session cwd, `PostToolUse` and `apply_patch`. Unverified: rejection of a `hooks.json` with a BOM and failure on unknown output keys (both observed locally, neither on the page).

## Cursor: `stop` in `.cursor/hooks.json`

`<project>/.cursor/hooks.json` or `~/.cursor/hooks.json` (enterprise and team sources exist too):

```json
{
  "version": 1,
  "hooks": {
    "stop": [{ "command": ".cursor/hooks/my-check.sh", "timeout": 600, "loop_limit": null }]
  }
}
```

Stdin (common fields plus the two `stop` fields):

```json
{
  "conversation_id": "c0ffee",
  "generation_id": "9a1b",
  "model": "...",
  "hook_event_name": "stop",
  "cursor_version": "1.7.2",
  "workspace_roots": ["/work/app"],
  "user_email": null,
  "transcript_path": null,
  "status": "completed",
  "loop_count": 0
}
```

| Field | Meaning |
|---|---|
| `conversation_id` | Stable across the conversation's turns. |
| `generation_id` | Changes with every user message. |
| `workspace_roots` | Workspace folders; normally one. There is no `cwd`. |
| `status` | `completed`, `aborted` or `error`. Only `completed` is worth checking. |
| `loop_count` | How many automatic follow-ups the stop hook has already triggered in this conversation; starts at 0. |

"Block": `{"followup_message": "..."}`. Cursor cannot veto the stop; it submits the text as the next user message. Allow: `{}`.

Loop safety and `loop_count` semantics:

- `loop_count` counts follow-ups per **conversation**, not per turn. It is not a "this stop follows my block" flag; a continuation is "`loop_count` is exactly one more than when I last blocked", which means the hook must remember the value between runs.
- `loop_limit` (per script, default 5, `null` for no limit) stops follow-ups once the count is reached. With the default, a gate goes silent after its fifth block in a long conversation and stays silent. Set `loop_limit: null` and cap per turn in the hook.

Gotchas:

- The `stop` payload has no final message. `afterAgentResponse` receives `{"text": "..."}`; a hook there can save the text under `conversation_id` for the `stop` hook to read.
- Project hooks run only in a trusted workspace, from the project root; user hooks run from `~/.cursor/`. Write project commands as `.cursor/hooks/x.sh`, not `./hooks/x.sh`.
- Hooks fail open; `failClosed: true` on an entry inverts that. Do not set it on a gate.
- Cursor also loads Claude Code hooks from `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json` when "Include Third-Party Plugins, Skills, and Other Configs" is enabled, which is the default. Those entries get `loop_limit: null`.
- When several sources answer, the last `followup_message` in priority order (enterprise, team, project, user) wins.
- Post-edit channel: `postToolUse` (matcher `Write`) accepts `{"additional_context": "..."}`, injected after the tool result. `afterFileEdit` has no output the agent sees.

Docs: https://cursor.com/docs/hooks and https://cursor.com/docs/reference/third-party-hooks

Checked: 2026-09-19. Verified: file locations, shape, `status`, `loop_count`, `followup_message`, `loop_limit` default and `null`, timeout in seconds, fail-open and `failClosed`, trusted workspace, working directories, third-party loading on by default, `postToolUse.additional_context`, `afterAgentResponse.text`. Unverified: the default timeout (the page says "platform default"); `additional_context` was not exercised on a file edit.

## Gemini CLI: `AfterAgent`

`.gemini/settings.json` (project) or `~/.gemini/settings.json` (user); project settings take precedence, extensions can bundle hooks.

```json
{
  "hooks": {
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [{ "name": "my-check", "type": "command", "command": "$GEMINI_PROJECT_DIR/my-check.sh", "timeout": 600000 }]
      }
    ]
  }
}
```

Stdin:

```json
{
  "session_id": "e3b0...",
  "transcript_path": "/home/me/.gemini/tmp/.../chats/session.json",
  "cwd": "/work/app",
  "hook_event_name": "AfterAgent",
  "timestamp": "2026-09-19T10:00:00.000Z",
  "prompt": "make the auth tests pass",
  "prompt_response": "Done. All tests pass.",
  "stop_hook_active": false
}
```

| Field | Meaning |
|---|---|
| `prompt` | The user's request for this turn. |
| `prompt_response` | The final text the agent produced. |
| `stop_hook_active` | This hook is already running as part of a retry sequence. |

Block (exit 0): `{"decision": "deny", "reason": "..."}`. The response is rejected and `reason` is sent to the agent as a new prompt. Exit 2 blocks with stderr as the reason. Allow: `{}` (or `{"decision": "allow"}`, optionally with `systemMessage`). `{"continue": false}` stops the session without a retry; `clearContext: true` clears the model's history.

Loop safety: `stop_hook_active`. No cap is documented.

Gotchas:

- **Timeouts are milliseconds**, default 60000. `"timeout": 600` is 0.6 s: the hook is killed before any check can finish, and the stop is allowed.
- **Stdout must be the final JSON and nothing else.** If stdout is empty, the runner parses stderr instead (`stdout.trim() || stderr.trim()`), and non-JSON text becomes a `systemMessage` on exit 0, a warning on exit 1, and a deny reason on other exit codes. A hook that logs to stderr should therefore always print `{}` when it allows.
- The first time Gemini CLI sees a project hook it warns; hooks are fingerprinted by name and command, so a changed command is a new, untrusted hook. The folder must be trusted. `/hooks panel` lists them.
- The hook runs in `cwd` with `GEMINI_PROJECT_DIR`, `GEMINI_CWD`, `GEMINI_SESSION_ID` and the alias `CLAUDE_PROJECT_DIR` set.
- Post-edit channel: `AfterTool` with matcher `write_file|replace`; `hookSpecificOutput.additionalContext` is appended to the tool result.

Docs: https://geminicli.com/docs/hooks/reference/ and https://geminicli.com/docs/hooks/

Checked: 2026-09-19. Verified: file locations and precedence, shape, millisecond timeouts and default, payload fields, `deny`/`reason`/`continue`/`clearContext`, exit codes, the stdout rule, fingerprinting, environment variables, `AfterTool`; the stderr fallback and plain-text conversion were read in `packages/core/src/hooks/hookRunner.ts`. Unverified: `prompt_response` being the literal `[no response text]` on a turn without text, and `additionalContext` reaching the model HTML-escaped (`->` as `-&gt;`); both observed locally.

## GitHub Copilot CLI: `agentStop`

Every `*.json` in `.github/hooks/` (repository) and in `~/.copilot/hooks/` (`$COPILOT_HOME/hooks/`) is loaded; hooks can also sit inline in `.github/copilot/settings.json` or `~/.copilot/settings.json`.

```json
{
  "version": 1,
  "hooks": {
    "agentStop": [
      { "type": "command", "bash": "./my-check.sh", "powershell": "./my-check.ps1", "timeoutSec": 600 }
    ]
  }
}
```

Stdin:

```json
{
  "sessionId": "5f2c...",
  "timestamp": 1789812000000,
  "cwd": "/work/app",
  "transcriptPath": "/home/me/.copilot/.../5f2c.jsonl",
  "stopReason": "end_turn",
  "stop_hook_active": false
}
```

| Field | Meaning |
|---|---|
| `sessionId`, `transcriptPath` | camelCase, unlike most other agents. |
| `timestamp` | Milliseconds since the epoch. |
| `stopReason` | Documented as `"end_turn"` only. |
| `stop_hook_active` | snake_case inside the camelCase payload. |

Block (exit 0): `{"decision": "block", "reason": "..."}`; `reason` becomes the prompt of another agent turn. Allow: `{"decision": "allow"}`.

Loop safety: `stop_hook_active`; after 8 consecutive blocks the CLI ends the turn anyway.

Gotchas:

- **`timeoutSec` defaults to 30**, and a timeout is fail-open: a test suite that takes 31 s never blocks anything. Set it explicitly.
- Exit code 2 is a warning here, not a block (it denies only on `preToolUse` and `permissionRequest`). Use stdout JSON.
- There is no final-message field, only `transcriptPath`.
- Hook files are read at startup; restart `copilot` after a change.
- Event names written in PascalCase (`Stop`, `PostToolUse`) select the VS Code-compatible format with snake_case fields.
- `.claude/settings.json` and `.claude/settings.local.json` in the repository are read as well.
- Post-edit channel: `postToolUse` (input `toolName`, `toolArgs`, `toolResult`; file tools are `edit` and `create`) may return `{"additionalContext": "..."}`, appended to the tool result the model sees; combined results are capped at 10 KB.

Docs: https://docs.github.com/en/copilot/reference/hooks-reference

Checked: 2026-09-19. Verified: file locations, shape, `timeoutSec` default 30, fail-open timeouts, payload, `decision`/`reason`, the cap of 8, exit 2 semantics, PascalCase format, reading of `.claude/settings*.json`, `postToolUse.additionalContext`. Unverified: whether the PascalCase `Stop` alias delivers `session_id` in place of `sessionId`.

## Qwen Code: `Stop`

`.qwen/settings.json` (project, trusted folders only) or `~/.qwen/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [{ "name": "my-check", "type": "command", "command": "my-check.sh", "timeout": 600000 }] }
    ]
  }
}
```

Stdin is Claude-shaped:

```json
{
  "session_id": "q-1",
  "transcript_path": "/home/me/.qwen/projects/.../chats/q-1.jsonl",
  "cwd": "/work/app",
  "hook_event_name": "Stop",
  "timestamp": "2026-09-19T10:00:00.000Z",
  "permission_mode": "default",
  "stop_hook_active": false,
  "last_assistant_message": "Done. All tests pass.",
  "background_tasks": [],
  "crons": []
}
```

Fields as in Claude Code, plus `timestamp`, `crons` and token counters (`context_usage`, `context_limit`, `input_tokens`).

Block (exit 0): `{"decision": "block", "reason": "..."}`; exit 2 is a blocking error. Allow: `{}`; `{"systemMessage": "..."}` allows with a note.

Loop safety: `stop_hook_active`; Qwen Code ends the turn after `stopHookBlockingCap` consecutive blocks (default 8, `QWEN_CODE_STOP_HOOK_BLOCK_CAP` for one run).

Gotchas:

- **Timeout unit changed.** Qwen Code forked Gemini CLI's millisecond timeouts; current builds read `timeout` in seconds (default 60) and treat a value of 1000 or more as milliseconds. A millisecond value of at least 1000, as in the snippet, means the same on old and new builds; a long timeout written in seconds (`600`) is 0.6 s on an old build.
- Event names are Claude's (`Stop`, `PostToolUse`), not Gemini's (`AfterAgent`, `AfterTool`), although the settings location and the `name` key come from Gemini CLI.
- Project hooks load only in a trusted folder. `disableAllHooks: true` turns hooks off. Settings are read at startup.
- Post-edit channel: `PostToolUse`, matcher on tool ids (`write_file`, `edit`); `hookSpecificOutput.additionalContext`.

Docs: https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/

Checked: 2026-09-19. Verified: file location, shape, the seconds/milliseconds rule and default, Stop fields, `decision`/`reason`, the cap and its variable, trusted folders, `disableAllHooks`, `PostToolUse` and `additionalContext`. Unverified: `replace` as a file-edit tool id (the page names `write_file` and `edit`; `replace` is Gemini heritage).

## Goose: `Stop` in a plugin's `hooks.json`

Hooks exist only inside a plugin directory: `<project>/.agents/plugins/<name>/hooks/hooks.json` or `~/.agents/plugins/<name>/hooks/hooks.json`.

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "${PLUGIN_ROOT}/my-check.sh", "timeout": 600 }] }
    ]
  }
}
```

Stdin:

```json
{ "event": "Stop", "session_id": "abc-123", "last_assistant_message": "Done. I updated the file and ran the tests." }
```

| Field | Meaning |
|---|---|
| `event` | The event name lives under `event`, not `hook_event_name`. |
| `last_assistant_message` | Present when the assistant produced text. |
| (absent) | No `cwd`: `working_dir` is sent on tool events only. No continuation flag. |

Block: `{"decision": "block", "reason": "..."}` on stdout, or exit 2 with the reason on stderr. Goose feeds the reason back as a hidden user message and continues the loop. Allow: exit 0 with empty stdout. Any other stdout (non-JSON, JSON without a decision, stray log lines) reads as "no decision".

Loop safety: there is no flag, so a hook can only count its own consecutive blocks per `session_id`. Goose caps consecutive `Stop` blocks and then ends the turn; `GOOSE_STOP_HOOK_BLOCK_CAP` raises the cap.

Gotchas:

- **No working directory** in the payload; the hook has to trust the directory it is started in.
- `timeout` is in seconds and defaults to 30.
- Commands run through `sh -c`, with `PLUGIN_ROOT` in the environment; on Windows that needs a POSIX `sh`.
- Plugins are discovered at startup.
- `on_failure: block` exists for `PreToolUse` only; Stop hooks always fail open.
- No post-edit channel: `PostToolUse` and `AfterFileEdit` are observation-only and their decisions are ignored.

Docs: https://goose-docs.ai/docs/guides/context-engineering/hooks/

Checked: 2026-09-19. Verified: plugin locations, shape, timeout unit and default, the Stop payload, `working_dir` on tool events only, block by JSON or exit 2, the cap and its variable, `sh -c`, `PLUGIN_ROOT`, observation-only post events; the hidden user message is from goose PR #9468. Unverified: the cap's default of 8, the directory a Stop hook runs in, and behaviour on Windows.

## Factory Droid: `Stop`

`.factory/hooks.json` (project) or `~/.factory/hooks.json` (user), with the event names at the top level. Without a `hooks.json`, Droid reads a `"hooks"` key in the matching `settings.json`.

```json
{
  "Stop": [
    { "hooks": [{ "type": "command", "command": "\"$FACTORY_PROJECT_DIR\"/my-check.sh", "timeout": 600 }] }
  ]
}
```

Stdin:

```json
{
  "session_id": "d-1",
  "transcript_path": "/home/me/.factory/sessions/d-1.jsonl",
  "cwd": "/work/app",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "tool_execution_count": 12,
  "elapsed_time": 48211
}
```

The envelope is Claude's; `tool_execution_count` and `elapsed_time` describe the turn. There is no final-message field.

Block (exit 0): `{"decision": "block", "reason": "..."}`, or exit 2 (stderr is fed back to Droid). Allow: exit 0 with empty stdout.

Loop safety: `stop_hook_active`. No cap is documented.

Gotchas:

- Once `hooks.json` exists, a `"hooks"` key in `settings.json` of the same scope is no longer read. An empty `hooks.json` left behind by an uninstall keeps masking it; delete the file.
- Hooks run from Droid's current directory, which can move during a session. Use absolute paths or `$FACTORY_PROJECT_DIR`.
- `timeout` is in seconds and defaults to 60.
- Droid snapshots hooks at startup and warns when the files change; review them in `/hooks`.
- Post-edit channel: `PostToolUse` with matcher `Create|Edit|ApplyPatch`; `hookSpecificOutput.additionalContext` adds context and `decision: "block"` sends `reason` back.

Docs: https://docs.factory.ai/reference/hooks-reference

Checked: 2026-09-19. Verified: file locations and the `settings.json` fallback, top-level event map, timeout unit and default, Stop fields, `decision`/`reason`, exit 2, working directory and `FACTORY_PROJECT_DIR`, `/hooks`, the startup snapshot, `PostToolUse.additionalContext` and the tool matcher names. Unverified: `tool_input` field names for `Create`, `Edit` and `ApplyPatch`; `systemMessage` as an output field (the page does not list it).

## Devin (CLI and Local): `Stop`

`.devin/hooks.v1.json` in the project is the bare event map. Every other location nests the same map under `"hooks"`: `.devin/config.json`, `.devin/config.local.json`, and the user config `~/.config/devin/config.json` (`%APPDATA%\devin\config.json` on Windows).

```json
{
  "Stop": [
    { "matcher": "", "hooks": [{ "type": "command", "command": "\"$DEVIN_PROJECT_DIR\"/my-check.sh", "timeout": 600 }] }
  ]
}
```

Stdin:

```json
{ "hook_event_name": "Stop", "session_id": "3f8d1c2a-...", "prompt_id": "b71e9d40-...", "stop_hook_active": false }
```

| Field | Meaning |
|---|---|
| `session_id` | Stable for the agent session. |
| `prompt_id` | Rotates on every user prompt; all hooks of one turn share it. |
| `stop_hook_active` | Whether a stop hook is already active. |
| (absent) | No `cwd`, no final message. `DEVIN_PROJECT_DIR` in the environment names the project root. |

Block (exit 0): `{"decision": "block", "reason": "..."}`; the reason is shown to the agent. Allow: exit 0 with empty stdout (or `{"decision": "approve"}`).

Loop safety: `stop_hook_active`. No cap is documented; the page only warns that a blocking stop hook can loop.

Gotchas:

- **Devin also loads Claude Code hooks**: `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude.json`, `~/.claude/settings.json` and `~/.claude/settings.local.json`, while `read_config_from.claude` is enabled, which is the default. A gate registered for Claude Code already runs under Devin; registering it again in `.devin/` runs it twice. Under Devin a Claude-registered hook gets Devin's payload (no `cwd`, no message).
- Project hook files are discovered in the working directory and its ancestors up to the repository root.
- `/hooks` lists the loaded hooks and their source files. Hooks are reported not to run in Restricted Mode.
- Post-edit channel: `PostToolUse` (tool names `edit`, `write`, `apply_patch`; `tool_response` has `success`, `output`, `error`); `hookSpecificOutput.additionalContext` is injected into the agent's context.

Docs: https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks and https://docs.devin.ai/cli/extensibility/hooks/overview

Checked: 2026-09-19. Verified: file locations and the bare/nested shapes, `session_id`/`prompt_id`/`stop_hook_active`, `DEVIN_PROJECT_DIR`, `decision`/`reason`, the exit-code table, `.claude/` loading and its default, `/hooks`, `additionalContext` for `PostToolUse`, timeout in seconds. Unverified: exit code 2 on `Stop` specifically (the table is generic), the default timeout, whether `matcher` may be omitted on `Stop` (the vendor example carries `"matcher": ""`), `tool_input` field names of the edit tools, and that hooks are skipped in Restricted Mode.

## Augment (Auggie CLI): `Stop`

`<workspace>/.augment/settings.json` (committed), `.augment/settings.local.json`, or `~/.augment/settings.json`; system-wide files under `/etc/augment/` and `C:\ProgramData\Augment\` take precedence.

```json
{
  "hooks": {
    "Stop": [
      {
        "metadata": { "includeConversationData": true },
        "hooks": [{ "type": "command", "command": ".augment/hooks/my-check.sh", "timeout": 600000 }]
      }
    ]
  }
}
```

Stdin (the `conversation` object only with `includeConversationData`):

```json
{
  "hook_event_name": "Stop",
  "conversation_id": "conv-xyz789",
  "workspace_roots": ["/work/app"],
  "agent_stop_cause": "end_turn",
  "conversation": {
    "timestamp": "2026-09-19T10:00:00-07:00",
    "userPrompt": "make the auth tests pass",
    "agentTextResponse": "Done. All tests pass.",
    "agentCodeResponse": [{ "path": "src/auth.ts", "changeType": "edit", "content": "..." }]
  }
}
```

| Field | Meaning |
|---|---|
| `conversation_id`, `workspace_roots` | Cursor-like envelope; there is no `cwd`. |
| `agent_stop_cause` | `end_turn`, `interrupted`, `max_iterations` or `error`. Only `end_turn` is a finished turn. |
| `conversation.agentTextResponse` | The agent's final text. |
| `conversation.agentCodeResponse` | Files changed in the turn: `path`, `changeType`, `content`. |

Block (exit 0), nested unlike every other agent:

```json
{ "hookSpecificOutput": { "hookEventName": "Stop", "decision": "block", "reason": "npm test fails. Fix it before finishing." } }
```

A top-level `{"decision": "block"}` is not the documented shape. Allow: exit 0 with empty stdout; `{"systemMessage": "..."}` shows the user a note.

Loop safety: no continuation flag and no documented cap. Count consecutive blocks per `conversation_id` in the hook.

Gotchas:

- **Script files only.** `command` must be a path to a `.sh`, `.ps1`, `.cmd` or `.bat` file, not a command line. `.sh` files need the executable bit and a shebang; `.ps1` runs through `powershell.exe -Command`, `.cmd`/`.bat` through `cmd.exe`. To run `npx something`, register a one-line wrapper script.
- **Timeouts are milliseconds**, default 60000.
- Exit code 2 blocks only on `PreToolUse`; on `Stop` it is a non-blocking error.
- `metadata` sits on the group next to `hooks`, not on the hook entry.
- `Stop` also fires on a user interrupt; check `agent_stop_cause`.
- Post-edit channel: `PostToolUse` (tools `str-replace-editor`, `save-file`; changed paths in `file_changes[].path`); `hookSpecificOutput.additionalContext` goes to the agent.

Docs: https://docs.augmentcode.com/cli/hooks

Checked: 2026-09-19. Verified: file locations, shape, script extensions and how each runs, millisecond timeouts and default, Stop payload, `includeConversationData` and its placement, the nested block shape, exit-code table, `PostToolUse.additionalContext`, tool names, `file_changes`. Unverified: whether Auggie caps consecutive Stop blocks, and the first version that shipped Stop hooks.

## OpenCode: a plugin on `session.idle`

OpenCode has no command hooks and no hook that can veto the end of a turn. Plugins are JavaScript or TypeScript modules in `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (user), loaded at startup and run under Bun. A plugin's `event` handler sees `session.idle`, but it is fire-and-forget: its return value is ignored. What a plugin can do is send a new prompt into the same session, which is the follow-up pattern:

```js
// .opencode/plugins/my-check.js
import { spawnSync } from "node:child_process";

const MARK = "[my-check]";

export const MyCheck = async ({ client, directory, worktree }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return;
    const id = event.properties.sessionID;
    const messages = (await client.session.messages({ path: { id } })).data ?? [];
    // Loop guard: count our own trailing follow-ups; there is no stop_hook_active.
    let sent = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.info.role !== "user") continue;
      if (m.parts.some((p) => p.type === "text" && p.text.startsWith(MARK))) sent++;
      else break;
    }
    if (sent >= 3) return;
    const run = spawnSync("./my-check.sh", { cwd: worktree || directory, encoding: "utf8" });
    if (run.status === 0) return;
    await client.session.promptAsync({
      path: { id },
      body: { parts: [{ type: "text", text: `${MARK} ${run.stdout}${run.stderr}`.slice(0, 9000) }] },
    });
  },
});
```

There is no stdin payload; everything comes from the SDK client: `client.session.get` (a `parentID` marks a subagent session), `client.session.messages` (the last assistant message's text parts are the final message; `info.error` marks a failed turn), and the plugin context (`directory`, `worktree`, which is `/` outside version control).

Gotchas:

- `promptAsync` returns at once; a blocking `prompt` call inside the idle handler would wait for the whole next turn. `spawnSync` above blocks the server's event loop for the length of the check; a real plugin should spawn asynchronously.
- The injected text is an ordinary, visible user message. Pass the original message's `agent` and `model` in the body, or OpenCode answers with its defaults.
- `session.idle` also fires after shell runs and compaction, and twice in quick succession at times. Ignore messages whose text parts are all `synthetic`, and keep one check in flight per session.
- In `opencode run` the process may exit before the follow-up is applied.
- Post-edit channel: `"tool.execute.after": async (input, output) => { ... }` with `input.tool` in `edit`, `write`, `apply_patch` and the arguments in `input.args` (`filePath`, or `patchText`); text appended to `output.output` reaches the model with the tool result.

Docs: https://opencode.ai/docs/plugins/

Checked: 2026-09-19. Verified: plugin directories, load at startup, Bun, the `session.idle` and `tool.execute.after` events. From the source (`packages/plugin/src/index.ts`, `packages/opencode/src/plugin/index.ts`, `packages/sdk/js`, v1.18.29), not the page: event handlers are not awaited, there is no `session.stopping`, and the `client.session.*` calls. Unverified: how the TUI renders a plugin-sent prompt, and whether `opencode run` stays alive long enough for it.

## Junie CLI: `Stop` (early access)

User scope only: `~/.junie/config.json`. A project `.junie/config.json` is ignored for safety unless Junie is started with `--config-location`.

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "~/bin/my-check.sh", "timeout": 600 }] }
    ]
  }
}
```

Stdin:

```json
{ "hook_event_name": "Stop", "stop_hook_active": false, "last_assistant_message": "Done. All tests pass." }
```

Three fields: no session id, no working directory.

Block: `{"decision": "block", "reason": "..."}` on stdout, or exit 2 with the reason on stderr; the reason goes back to the agent for a retry. Allow: exit 0 with empty stdout.

Loop safety: `stop_hook_active`; Junie honours 8 consecutive blocks per task (`JUNIE_STOP_HOOK_BLOCK_CAP`, `0` disables the cap).

Gotchas:

- Because the file is user-scoped, the hook runs for every project; it must find the repository from the directory it is started in and do nothing where it does not apply.
- Without a session id, per-session state has to be keyed by something else, such as the repository.
- `blockOnError: true` turns any non-zero exit into a block. Leave it off for a gate, or a crashing check locks the agent in.
- `timeout` is in seconds; the default for `Stop` is 600. Commands run through `sh -c` (`cmd /c` on Windows).
- Hooks need the EAP build and run in the interactive TUI and in `-p` batch mode, not under ACP or server hosts.
- No post-edit channel: the events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`, `StopFailure` and `SessionEnd`.

Docs: https://junie.jetbrains.com/docs/junie-cli-hooks.html

Checked: 2026-09-19. Verified: config location and `--config-location`, EAP status, shape, timeout unit and per-event defaults, the three Stop fields, block by JSON or exit 2, `blockOnError`, the cap and its variable, supported modes, the event list. Unverified: the directory a Stop hook runs in.

## Agents without a usable end-of-turn gate

| Agent | What exists | Nearest alternative |
|---|---|---|
| Windsurf / Cascade | `.windsurf/hooks.json`, `~/.codeium/windsurf/hooks.json`. `post_cascade_response` receives the response text in `tool_info.response`, but only `pre_*` hooks can block (exit 2), and post-hook output is shown to the user at most, never to the agent. | Log or notify from `post_cascade_response`; verify in CI. |
| Cline | No Stop event. Current docs describe SDK plugins with `beforeTool`/`afterTool`/`afterRun` hooks (stages `tool_call_before`, `run_end`, ...); only `tool_call_before` is documented for blocking. | Gate the completion tool: block the `attempt_completion` tool call from a `beforeTool` hook (in the older file hooks, a `PreToolUse` script that returns `{"cancel": true, "errorMessage": "..."}`) until the checks pass. |
| Kiro | An "Agent Stop" trigger in `.kiro/hooks/<id>.json` runs a shell command or sends an agent prompt after the response. A non-zero exit blocks only on Pre Tool Use and Prompt Submit. | An Agent Stop hook with a shell command: on a non-zero exit its stderr is sent to the agent. It cannot hold the turn open, and an agent-prompt action fires unconditionally. |
| Amp | No command hooks. A plugin (`.amp/plugins/`, `~/.config/amp/plugins/`, run under Bun) may return `{ action: "continue", userMessage }` from its `agent.end` handler; Amp ignores it after `maxContinuations` (default 5) consecutive plugin continuations. | That handler is a follow-up gate in the Cursor/OpenCode sense; the payload carries the turn's `messages`, not a final-text field. |
| Crush | `crush.json` `"hooks"` supports one event, `PreToolUse` (exit 2 denies; `halt` ends the turn). | None at the end of the turn. |
| Roo Code, Kilo Code | No hook or plugin interface for session lifecycle events. | Instructions plus CI. |
| Aider | No hooks. | `aider --auto-test --test-cmd "<command>"` runs the command after every edit and sends a non-zero exit's output back to the model to fix. It is a post-edit loop, not a completion gate. |

Docs: https://docs.devin.ai/desktop/cascade/hooks (Windsurf's page redirects there), https://docs.cline.bot/sdk/plugins, https://kiro.dev/docs/hooks/, https://ampcode.com/docs/plugin-api, https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md, https://aider.chat/docs/usage/lint-test.html

Checked: 2026-09-19. Verified: Windsurf events, locations and "post-hooks cannot block"; Cline's hook names and stages; Kiro's trigger list, storage and exit-code rules; Amp's `agent.end` result type and `maxContinuations`; Crush's single event; Aider's `--auto-test`. Unverified: that Cline routes `attempt_completion` through `beforeTool`; whether a Kiro Agent Stop command's output starts a new turn; Roo Code and Kilo Code (no documentation of hooks was found, which is not proof of absence).

## Writing a portable stop hook

The rules below are the ones a gate needs in order to survive contact with twelve different hosts. They matter more than any single payload detail.

1. **Never fail closed on your own errors.** Malformed or empty stdin, a BOM in front of the JSON, an unreadable config, a state directory that cannot be written, an exception: all of them end in the host's *allow* output and exit code 0. Do not set the host's fail-closed switches (`failClosed` in Cursor, `blockOnError` in Junie) on a gate. A gate that can lock the agent in gets uninstalled.
2. **Answer in stdout JSON with exit 0.** Exit 2 blocks on some hosts, warns on Copilot CLI and means nothing on Augment's `Stop`. Print the JSON object and nothing else; send diagnostics to stderr; on Gemini CLI and Qwen Code print `{}` instead of nothing.
3. **Cap consecutive blocks yourself.** Use the host's flag when there is one (`stop_hook_active`), the `loop_count` delta on Cursor, and a persisted per-session counter when there is neither (Goose, Augment). Keep the counter on disk keyed by host and session id, reset it on a pass, and after the cap (3 is a reasonable default, below every host's own 5 or 8) allow the stop with a message the user sees. If the counter cannot be persisted, allow: an uncounted block is an unbounded loop.
4. **Only judge finished turns.** Skip when the host says the turn was aborted, interrupted or errored (`status`, `agent_stop_cause`), in plan mode, and when background tasks are still running and the message claims nothing.
5. **Quote the claim.** When the host passes the final message, find the sentence that claims completion and put it in the reason next to the failing output ("You claimed: ..."). The same sentence decides how much to run: fast checks on every stop, the full suite only when the message claims the work is done. When the host passes no message (Cursor, Copilot CLI, Droid, Devin), run everything and lean on the cache.
6. **Bound the reason.** Claude Code caps hook text at 10,000 characters and Copilot CLI at 10 KB; stay under about 9,000, keep the last lines of each failing command rather than the first, and mark the cut.
7. **Cache by tree hash.** Hash the working tree, tracked changes and untracked files alike (a temporary git index does it without touching `.git/objects`), and reuse a pass for the same tree and the same check configuration. Agents stop often; a stop that changes nothing must cost nothing.
8. **Set the timeout explicitly, in the host's unit.** Defaults range from 30 s (Copilot CLI, Goose) to 600 s, two hosts count in milliseconds, and a timed-out hook is an allowed stop everywhere.
9. **Register once per repository.** Cursor, Devin, Copilot CLI and Continue all read `.claude/settings.json`; a second native registration runs the checks twice and may block twice.
10. **Guard against recursion.** If a check can start the gate again (a Makefile target, a nested agent), set an environment variable while checks run and allow immediately when it is present.
11. **Find the directory defensively.** Prefer `cwd`, then `workspace_roots`, then the host's project variable (`CLAUDE_PROJECT_DIR`, `GEMINI_PROJECT_DIR`, `FACTORY_PROJECT_DIR`, `DEVIN_PROJECT_DIR`), then the process directory, and walk up to the repository root from there.

A minimal gate for the Claude-shaped hosts (Claude Code, Codex CLI, Qwen Code, Goose, Droid, Devin, Junie), with the crudest possible loop guard, never blocking twice in a row:

```sh
#!/bin/sh
# my-check.sh: refuse the stop while the tests fail.
payload=$(cat)
case "$payload" in *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;; esac
out=$(npm test 2>&1) && exit 0
# node is used only to JSON-encode the reason; keep the tail, where the failures are.
printf '%s' "$out" | tail -n 30 | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () =>
    process.stdout.write(JSON.stringify({ decision: "block", reason: "Tests fail. Fix them before finishing:\n" + s.slice(-9000) })));'
```

On Goose and Augment, which send no flag, this script would block on every stop until the agent's own cap; that is rule 3.

[isitdone](https://github.com/raimondasl/isitdone) implements all of these adapters and rules.
