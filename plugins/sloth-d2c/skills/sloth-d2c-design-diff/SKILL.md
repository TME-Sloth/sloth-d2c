---
name: sloth-d2c-design-diff
description: "Compare the Sloth/Figma design screenshot with the generated implementation preview and iterate until the generated UI is visually restored."
---

# Sloth D2C Visual Diff

Use this skill when Codex should compare the design screenshot with the generated implementation and repair visual differences. This is a Codex/script workflow, not a new control panel in the interceptor.

## Flow

1. Run the `design-diff` command or the visual comparison command returned by the handoff/guide.
2. Keep the Codex in-app browser on the Sloth interceptor.
3. Capture the target `implementationUrl` with a headless/local screenshot tool.
4. Compare, inspect mismatch ratio and diff artifacts, then repair local code/styles.
5. Repeat until the implementation is close enough or remaining differences are clearly explained.

Do not run visual diff in `design_prepare`. If there is no `implementationUrl`, finish first generation before comparing.

When visual diff is tied to a human event, finish by running `complete-event` for that event with the changed files, checks, and visual diff summary.
