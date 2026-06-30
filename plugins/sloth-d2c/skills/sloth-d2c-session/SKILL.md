---
name: sloth-d2c-session
description: "用于检查和推进 Sloth D2C 持久化会话；适用于读取用户标注、确认已处理事件或写入 agent 结果。"
---

# Sloth D2C 会话

用于处理 `.sloth/<fileKey>/<nodeId>/session/` 下的持久化会话。常规工作优先使用 `workflow-handoff`，因为它会返回阶段、事件摘要和可直接运行的命令。

## 主入口

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id codex
```

当 workflow 要求打开拦截页时，在 Codex 内置浏览器中打开 `commands.openUrl`。保持该浏览器停留在 Sloth 页面；目标预览截图使用 headless/local 工具完成。

如果 Browser 插件可用，先加载并使用其 `control-in-app-browser` skill。只有当 Codex 内置浏览器不可用或控制失败时，才使用会打开系统默认浏览器的 shell helper，例如 `open`、`xdg-open`、`start`、`osascript`、AppleScript 或直接调用 Chrome/Safari。

## 阶段

- `design_prepare`：打开拦截页，然后停止并等待用户提交。
- `initial_generation_requested`：处理 `workflow.submitted`，走首次转码流程：先运行/校验 Sloth D2C chunks，再消费 group chunks 与聚合/最终 prompts 写项目代码，设置 `implementationUrl`，最后完成事件。
- `initial_generating`：继续第一次生成，直到存在可访问的 `implementationUrl`。
- `implementation_loop`：等待用户提交生成预览标注。
- `implementation_annotations_requested`：只处理当前提交的标注并完成事件。
- `design_diff_requested`：根据视觉 diff 上下文修复，并在适用时完成关联事件。

对于第一次有分组的提交，不要把只包含 `codeAggregation.md` 和 `finalGenerate.md` 的 chunk 目录视为完整。实现开始前应存在 `0.md`、`1.md` 等 group chunk 文件。

## 事件规则

- 只处理新的、未确认的用户事件。
- 使用脚本返回的事件聚焦上下文，不要默认扫描所有历史标注。
- 请求的工作真正处理完成前不要 ack。
- 正常完成时使用 `complete-event`；它会写入 agent 结果并确认事件。

## 命令来源

优先使用 `workflow-handoff` / `workflow-guide` 返回的命令字符串，不要根据 skill 文本重新拼接脚本参数。
