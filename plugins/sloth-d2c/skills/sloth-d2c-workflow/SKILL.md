---
name: sloth-d2c-workflow
description: "Run the end-to-end Sloth D2C workflow through the Sloth interceptor page, persistent sessions, snapshots, and incremental annotation events."
---

# Sloth D2C Workflow

Use this skill to connect Codex with the Sloth D2C interceptor. The interceptor is the user interaction surface; Codex should read and write the target project's `.sloth/<fileKey>/<nodeId>/session/` state through the plugin scripts.

## Start

Resolve `<plugin-root>` from this skill directory, then request the current handoff:

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id codex
```

Read `workflowPhase`, `recommendedAction`, `stopCondition`, `commands`, `nextEvent`, and `eventBrief`. Prefer the returned `commands.*` values over reconstructing script commands by hand.

Use `--local` only when the user explicitly asks for Figma plugin/local cached data. Use `--dev` or `--dev-port` only for repository development.

## Phase Handling

### `design_prepare`

Open `commands.openUrl` in the Codex in-app browser. Confirm the Sloth D2C page and design preview are visible, then stop this turn and ask the user to continue after submitting the first workflow.

Do not generate code, start the target app, write `implementationUrl`, ack events, or run long polling in this phase.

### `initial_generation_requested`

The user has submitted `workflow.submitted`.

1. Ensure initial chunks/prompts exist. If `initialGeneration.mustRunSlothD2cBeforeCoding` is true, run `commands.generateChunks`.
2. Claim the event before editing code.
3. Generate or update the target implementation from the Sloth chunks/prompts and submitted context.
4. Start or identify the target app preview.
5. Write `implementationUrl` with the returned command pattern.
6. Reopen or keep the Sloth interceptor in the Codex in-app browser.
7. Run focused checks, then complete the event.

Do not hand-write the first implementation from screenshots while required chunks/prompts are missing.

### `initial_generating`

Continue the first generation path until a reachable `implementationUrl` exists. Keep the Codex in-app browser on the Sloth interceptor, not the target preview.

### `implementation_loop`

Open or keep the Sloth interceptor visible. Wait for the user to submit generated-preview annotations, or end the turn and let the user come back later.

### `implementation_annotations_requested`

Use `commands.eventBrief` or `annotation-workflow` context to handle the current event. Focus on `changedCanvasAnnotations`, especially `target=implementation`, edit the local implementation, run focused checks, optionally run visual comparison, then complete the event.

### `design_diff_requested` / `legacy_repair_requested`

Use the event brief and visual comparison helpers to repair the implementation. If the request came from a human event, complete that event after the fix.

## Event Semantics

- `workflow.submitted`: first code generation can start.
- `annotation.submitted`: user saved generated-preview annotations.
- `diff.confirmed`: user accepted a visual diff repair request.
- `repair.requested`: compatibility repair event.
- `annotation.saved`: snapshot/history save only; it is not a default repair request.

Only process new, unacknowledged human events. `complete-event` is the normal way to write the agent result and ack the handled event.

## Closeout

Report the current phase, whether the interceptor is open, handled event ids, `implementationUrl` status, changed files, and checks run. In `design_prepare`, simply report that the page is open and waiting for user submission.
