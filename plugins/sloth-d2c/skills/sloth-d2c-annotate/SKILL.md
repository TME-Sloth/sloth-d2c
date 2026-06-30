---
name: sloth-d2c-annotate
description: "用于检查 Sloth 会话标注、读取新的用户标注事件，或记录面向 agent 的中间说明。"
---

# Sloth D2C 标注事件

用于处理和标注相关的 Sloth 会话工作。用户的视觉标注应通过 Sloth 拦截页提交；Codex 不应改写历史事件。

## 读取

使用 `sloth-d2c-state.mjs` 的 `pending-events`、`event-context` 或 `annotation-workflow` 查看新的用户事件。优先读取 `changedCanvasAnnotations`、`changedAnnotationIds` 和目标分组 id 等聚焦字段，不要默认扫描所有历史标注。

`annotation.saved` 是快照历史，不是默认修复请求。生成预览的修复通常来自 `annotation.submitted`。

## 写入

仅在记录说明或中间 agent 状态时使用 `append-agent-event`。请求已处理完成时使用 `complete-event`，它会写入 agent 结果并确认事件。

不要确认尚未完成的工作。除非用户明确要求 Codex 直接修改分组数据文件，否则不要改写 `groupsData.json`。
