---
name: sloth-d2c-annotate
description: "Inspect Sloth session annotations and append agent-facing annotation events. Use when Codex needs to record an agent note or inspect new user annotations."
---

# Sloth D2C Annotation Events

Use this skill for annotation-focused session work. Human visual annotations should come through the Sloth interceptor; Codex should not rewrite old events.

## Read

Use `pending-events`, `event-context`, or `annotation-workflow` from `sloth-d2c-state.mjs` to inspect new human events. Prefer focused fields such as `changedCanvasAnnotations`, `changedAnnotationIds`, and target group ids over scanning all historical annotations.

`annotation.saved` is snapshot history, not a default repair request. Generated-preview repairs normally come from `annotation.submitted`.

## Write

Use `append-agent-event` only for notes or intermediate agent records. Use `complete-event` when a request has been handled; it writes the agent result and acks the event.

Do not ack unfinished work. Do not rewrite `groupsData.json` unless the user explicitly asks Codex to change grouping data by file.
