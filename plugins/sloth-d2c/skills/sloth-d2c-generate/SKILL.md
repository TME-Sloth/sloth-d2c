---
name: sloth-d2c-generate
description: "Run the Sloth D2C CLI and prepare generated chunks for Codex processing. Use when the user asks to run D2C, convert Figma to code, generate chunks, or continue Sloth code generation."
---

# Sloth D2C Generate

Use this skill to create or refresh Sloth D2C chunks/prompts. In the full workflow, first open the interceptor and wait for `workflow.submitted`; do not bypass user submission for ordinary requests such as "convert this Figma design" or "use local cache". Bypass the interceptor only when the user explicitly asks for a standalone/silent/no-UI run, to skip the interceptor, or to refresh chunks/design data only.

## Inputs

Need `fileKey` and `nodeId`. Ask a short clarification only when they cannot be inferred from the current `.sloth` session.

## Preferred Path

In workflow mode, run the generation command returned by `workflow-handoff.commands.generateChunks`. It checks existing chunks, calls the Sloth D2C atomic CLI when needed, and validates the expected outputs.

Use `--local` only when the user explicitly asks for Figma plugin/local cached data. Otherwise use the default REST data source.

## Direct CLI

For explicit standalone D2C requests, run `sloth d2c --file-key <fileKey> --node-id <nodeId> --json` with only the options the user requested, such as `--framework`, `--depth`, `--local`, `--update`, or `--silent`.

After generation, parse the JSON output, record `chunksDir`, and confirm the required prompts exist. With grouped submissions, expect group chunk files plus `codeAggregation.md` and `finalGenerate.md`; with no groups, `codeAggregation.md` and `finalGenerate.md` are still required.

## Closeout

Report `chunksDir`, current workflow phase, pending human event status, and the recommended next step.
