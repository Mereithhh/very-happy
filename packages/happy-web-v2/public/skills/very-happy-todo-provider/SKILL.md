---
name: very-happy-todo-provider
description: Connect an external task source to the Very Happy Todo panel on a user-selected machine. Use for configuring or troubleshooting a todo provider; built-in My todos needs no setup.
---

# Connect an external Todo source

Very Happy has a built-in account-synced list under **Todos → My todos**. Only use this setup when the user wants an external source under **Todos → External source**. External tasks stay in their original service; do not import or complete them as part of setup.

1. Identify the machine selected in External source, its running daemon user and effective `HAPPY_HOME_DIR` (default `~/.happy`). Configure on that machine, not necessarily the computer running this agent. Read only the relevant existing `todoProvider` field; preserve all other settings and machine identity.
2. Read the current contract at https://github.com/Mereithhh/very-happy/blob/main/docs/channels.md#inbound-todo-provider-external-task-lists-in-the-web-ui . Inspect any existing provider before replacing it. No official Dida/TickTick, Todoist or Linear OAuth connector is bundled with this skill. Use a user-authorized existing integration or implement an adapter for the chosen service.
3. A provider accepts `list`, `create <title>` and `complete <id>` as argv. `list` prints JSON `{ "items": [{ "id": "stable-source-id", "title": "Task", "status": "open" }] }` to stdout. Optional fields: `note`, `group`, `priority` (`none|low|medium|high`) and `due`. Return nonzero and a useful stderr message on failure. Do not hide a failed source behind an empty successful list. Use subprocess argv arrays, never interpolate task titles into shell commands.
4. Keep credentials in the chosen integration's local credential store. Do not place credentials in provider output, public files or chat. If authorization is missing, let the user authorize the service through its supported flow.
5. Back up the current settings file privately, then merge only `todoProvider`: `{ "command": "/absolute/path/to/executable", "args": [], "timeoutMs": 30000 }`. Use an absolute executable path and explicit arguments. The daemon reads settings for each RPC; a daemon restart is not normally needed.
6. Validate adapter create/complete behavior with a disposable local fixture or mocked service. A real `create` or `complete` modifies the user's task system; do not use existing tasks as probes. Run real `list` read-only, check IDs are unique and results are complete. If Tanka follow-ups already sync into another source, expose that single source to avoid duplicates.
7. Return to **Todos → External source**, select the configured machine and refresh. Confirm the expected task count/source, and explain which source receives new tasks. On failure, preserve the old configuration and report the specific stage. Restore only the backed-up provider field if rollback is needed, preserving intervening settings changes.

A local JSON-file adapter is available at https://github.com/Mereithhh/very-happy/blob/main/packages/happy-cli/examples/todo-provider-jsonfile.mjs for an isolated setup test.
