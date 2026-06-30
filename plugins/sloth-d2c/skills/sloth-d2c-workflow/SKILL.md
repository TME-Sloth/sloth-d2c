---
name: sloth-d2c-workflow
description: "用于通过 Sloth 拦截页、持久化会话、快照和增量标注事件运行端到端 Sloth D2C 工作流。"
---

# Sloth D2C 工作流

用于连接 Codex 与 Sloth D2C 拦截页。拦截页是用户交互界面；Codex 应通过插件脚本读写目标项目的 `.sloth/<fileKey>/<nodeId>/session/` 状态。

默认用户请求，例如“转换这个 Figma 设计”“使用 Sloth D2C”或“使用本地缓存”，仍从拦截页开始。`--local` 只作为拦截页和 D2C 命令的数据源选择。除非用户明确要求独立/静默/无 UI 运行、跳过拦截页，或仅刷新 chunks，否则不要绕过拦截页。

## 开始

从当前 skill 目录解析 `<plugin-root>`，然后请求当前 handoff：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id codex
```

读取 `workflowPhase`、`recommendedAction`、`stopCondition`、`commands`、`nextEvent` 和 `eventBrief`。优先使用返回的 `commands.*`，不要手动重建脚本命令。

只有当用户明确要求 Figma 插件/本地缓存数据时才使用 `--local`。`--dev` 或 `--dev-port` 仅用于仓库开发。

## 首次转码约定

`workflow.submitted` 之后的第一次转码遵循旧版 `sloth d2c` skill 流程，唯一变化是浏览器界面改为 Codex 内置浏览器：

1. 运行 Sloth D2C chunk 生成命令。
2. 处理 group chunk prompts 和聚合 prompt。
3. 使用最终 prompt 写入可运行的项目文件。

对于有分组的提交，有效 chunk 输出应包含一个或多个 group chunk 文件，例如 `0.md`、`1.md` 等，并且包含 `codeAggregation.md` 和 `finalGenerate.md`。当提交中存在分组时，只有 `codeAggregation.md` 和 `finalGenerate.md` 不够。首次实现代码开始前，必须先运行 chunk 生成并检查预期的 chunk 结构。

## 浏览器界面

当 workflow 要求打开或保持拦截页可见时，优先使用 Codex 内置浏览器。如果 Browser 插件可用，加载其 `control-in-app-browser` skill，并通过该浏览器界面打开 `commands.openUrl`。

只有当 Codex 内置浏览器不可用或控制失败时，才使用会打开系统默认浏览器的 shell helper，例如 `open`、`xdg-open`、`start`、`osascript`、AppleScript 或直接调用 Chrome/Safari。`curl`/HTTP 探测可以确认可达性，但不等同于完成“打开拦截页”步骤。

## 阶段处理

### `design_prepare`

在 Codex 内置浏览器中打开 `commands.openUrl`。确认 Sloth D2C 页面和设计预览可见，然后结束当前回合，等待用户提交首次 workflow 后继续。

此阶段不要生成 chunks、不要生成代码、不要启动目标应用、不要写入 `implementationUrl`、不要 ack 事件，也不要运行长轮询。即使用户提供了 `fileKey`、`nodeId`、`--local`，或点击了提到转码的默认 prompt，也仍然如此。

### `initial_generation_requested`

用户已提交 `workflow.submitted`。

1. 读取 `eventBrief` / `nextEvent`，理解提交的分组和生成意图。
2. 写实现代码前先运行 `commands.generateChunks`。这对应旧流程中 `sloth d2c --json` 的第一步，会生成/刷新 chunk prompts。
3. 校验生成的 chunk 目录。有分组提交时，应看到 `0.md`、`1.md` 等 group chunk 文件，并且有 `codeAggregation.md` 和 `finalGenerate.md`。
4. 编辑项目代码前先 claim 事件。
5. 基于 Sloth chunks/prompts 和提交上下文生成或更新目标实现。先处理 group chunks，再处理聚合/最终生成，匹配旧版 chunk -> aggregation -> final write 流程。
6. 启动或识别目标应用预览。
7. 使用返回的命令模式写入 `implementationUrl`。
8. 重新打开或保持 Sloth 拦截页在 Codex 内置浏览器中。
9. 运行聚焦校验，然后完成事件。

必需的 chunks/prompts 缺失时，不要仅凭截图手写第一次实现。

### `initial_generating`

继续第一次生成路径，直到存在可访问的 `implementationUrl`。保持 Codex 内置浏览器停留在 Sloth 拦截页，而不是目标预览页。

### `implementation_loop`

打开或保持 Sloth 拦截页可见。等待用户提交生成预览标注；也可以结束当前回合，让用户稍后回来继续。

### `implementation_annotations_requested`

使用 `commands.eventBrief` 或 `annotation-workflow` 上下文处理当前事件。聚焦 `changedCanvasAnnotations`，尤其是 `target=implementation` 的标注；修改本地实现，运行聚焦校验，可选运行视觉对比，然后完成事件。

### `design_diff_requested` / `legacy_repair_requested`

使用事件摘要和视觉对比 helper 修复实现。如果请求来自用户事件，修复后完成该事件。

## 事件语义

- `workflow.submitted`：可以开始第一次代码生成。
- `annotation.submitted`：用户保存了生成预览标注。
- `diff.confirmed`：用户接受了视觉 diff 修复请求。
- `repair.requested`：兼容性修复事件。
- `annotation.saved`：仅表示快照/历史保存，不是默认修复请求。

只处理新的、未确认的用户事件。`complete-event` 是写入 agent 结果并确认已处理事件的常规方式。

## 收尾

报告当前阶段、拦截页是否已打开、已处理事件 id、`implementationUrl` 状态、变更文件和已运行校验。在 `design_prepare` 阶段，只需报告页面已打开并等待用户提交。
