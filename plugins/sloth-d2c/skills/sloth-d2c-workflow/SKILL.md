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
2. 优先使用 subagents 并行处理 group chunk prompts。
3. 使用最终 prompt 写入可运行的项目文件。

对于有分组的提交，有效 chunk 输出应包含一个或多个 group chunk 文件，例如 `0.md`、`1.md` 等，并且包含 `codeAggregation.md` 和 `finalGenerate.md`。当提交中存在分组时，只有 `codeAggregation.md` 和 `finalGenerate.md` 不够。首次实现代码开始前，必须先运行 chunk 生成并检查预期的 chunk 结构。

有分组 chunk 时，建议把 chunk 转码工作拆给 subagents：每个 subagent 只处理一个或一小组独立的 group chunk，返回组件代码、依赖资源、样式要点和风险。这样更接近旧 skill 的并行 chunk 处理方式，也能减少主 agent 串行读取所有 chunks 后独自转码的风险。一般最多同时派发 6 个 subagents；group chunks 多于 6 个时可分批派发。若当前运行环境没有可用 subagent 能力，或任务规模很小，也可以由主 agent 直接处理，并在收尾说明采用了哪种路径。

## 浏览器界面

当 workflow 要求打开或保持拦截页可见时，优先使用 Codex 内置浏览器。如果 Browser 插件可用，加载其 `control-in-app-browser` skill，并通过该浏览器界面打开 `commands.openUrl`。

只有当 Codex 内置浏览器不可用或控制失败时，才使用会打开系统默认浏览器的 shell helper，例如 `open`、`xdg-open`、`start`、`osascript`、AppleScript 或直接调用 Chrome/Safari。`curl`/HTTP 探测可以确认可达性，但不等同于完成“打开拦截页”步骤。

Codex 内置浏览器应保持在 Sloth 拦截页，不要直接导航到真实实现页或本地 Vite/预览 URL 做 smoke check。实现页检查应通过 Sloth 拦截页中转：写入 `implementationUrl` 后，让拦截页承载生成预览，再用 Codex 自带截图能力截取拦截页中的预览区域进行验证。

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
5. 适合并行时，为 group chunk 文件派发 subagents 转码。每个 subagent 的输入应包含对应 `{index}.md`、相关截图/资源路径、项目技术栈约束和输出格式要求。
6. 主 agent 汇总 subagent 输出，再消费 `codeAggregation.md` 和 `finalGenerate.md` 生成或更新目标实现，匹配旧版 chunk -> aggregation -> final write 流程。
7. 启动或识别目标应用预览，但不要把 Codex 内置浏览器直接打开到该真实预览 URL。
8. 使用返回的命令模式写入 `implementationUrl`。
9. 重新打开或保持 Sloth 拦截页在 Codex 内置浏览器中，通过拦截页查看生成预览。
10. 运行聚焦校验；视觉校验使用 Codex 自带截图能力截取 Sloth 拦截页/生成预览，不要自写截图脚本，然后完成事件。

必需的 chunks/prompts 缺失时，不要仅凭截图手写第一次实现。

### `initial_generating`

继续第一次生成路径，直到存在可访问的 `implementationUrl`。保持 Codex 内置浏览器停留在 Sloth 拦截页，而不是目标预览页；需要看生成效果时，通过拦截页中的生成预览查看和截图。

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

报告当前阶段、拦截页是否已打开、已处理事件 id、chunk 处理方式（subagent 并行或主 agent 直接处理）、`implementationUrl` 状态、变更文件和已运行校验。在 `design_prepare` 阶段，只需报告页面已打开并等待用户提交。
