---
name: sloth-d2c-session
description: "Inspect and advance Sloth D2C persistent session state. Use when Codex needs to read user annotations, acknowledge processed events, or write agent results."
---

# Sloth D2C Session

Use this skill for the persistent session under `.sloth/<fileKey>/<nodeId>/session/`. Prefer `workflow-handoff` for normal work because it returns the phase, event brief, and ready-to-run commands.

## Main Entry

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id codex
```

Open `commands.openUrl` in the Codex in-app browser when the workflow asks for the interceptor. Keep that browser on the Sloth page; use headless/local tools for target preview screenshots.

If the Browser plugin is available, load its `control-in-app-browser` skill and use that surface first. Use shell helpers that open the system default browser, including `open`, `xdg-open`, `start`, `osascript`, AppleScript, or direct Chrome/Safari commands, only after the Codex in-app browser is unavailable or control fails.

## Phases

- `design_prepare`: open the interceptor, then stop and wait for user submission.
- `initial_generation_requested`: handle `workflow.submitted`, generate from Sloth chunks/prompts, set `implementationUrl`, then complete the event.
- `initial_generating`: finish first generation until `implementationUrl` is reachable.
- `implementation_loop`: wait for generated-preview annotations.
- `implementation_annotations_requested`: handle only the current submitted annotations and complete the event.
- `design_diff_requested`: repair from visual diff context and complete the related event when applicable.

## Event Rules

- Process only new, unacknowledged human events.
- Use event-focused context returned by the script instead of scanning all historical annotations.
- Do not ack before the requested work is actually handled.
- Use `complete-event` for normal completion; it writes `agent.result` and acks the event.

## Command Source

Prefer command strings returned by `workflow-handoff` / `workflow-guide` instead of reconstructing script arguments in the skill text.
