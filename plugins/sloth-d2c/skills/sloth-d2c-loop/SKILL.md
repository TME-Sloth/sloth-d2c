---
name: sloth-d2c-loop
description: "用于继续 Sloth D2C 生成稿修改闭环。适用于用户保存生成预览标注、要求只处理某个 eventId、继续 implementation loop、处理 annotation.submitted/diff.confirmed/repair.requested 事件并写回 agent 结果。"
---

# Sloth D2C Loop

用于承接保存生成稿标注后的一句话 prompt。默认流程是事件定位、必要代码修改、一个最小检查和 `complete-event`。

## 入口

先从用户 prompt 提取 `fileKey`、`nodeId`、`eventId`、`implementationUrl` 和 `agentId`。未给 `agentId` 时使用 `local-agent`。

运行插件脚本返回聚焦上下文，优先使用 `workflow-handoff` / `annotation-workflow` 返回的命令字符串：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id <agentId>
```

如果 prompt 给了 `eventId`，读取该事件：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs annotation-workflow \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id <agentId> \
  --event-id <eventId>
```

## 处理规则

- 只处理当前 `eventId`，不要默认扫描或重放历史标注。
- 对 `annotation.submitted`，只消费事件里的 `changedCanvasAnnotations`，并且只处理 `target=implementation` 的标注。
- 默认不要读取 `loop/snapshots/*.json` 的全量内容；只有事件缺少 changed annotations 或明确需要恢复某个分组上下文时，才读取对应 snapshot。
- 对 `diff.confirmed` 或 `repair.requested`，按事件摘要修复；只有事件明确要求视觉 diff 时才进入 `sloth-d2c-design-diff`。
- 修改本地生成代码/样式后，运行一个能证明改动生效的最小检查。普通交互/文案/样式标注不要默认截图、不要默认跑 `design-diff` 或 `visual-compare`。
- 请求真正完成前不要 ack。
- 中间进度保持简短；不要逐条播报每个命令和尝试。最终只汇报处理的 event、改动文件、检查结果和 ack 状态。

## 写回

完成后使用 `complete-event` 写回摘要、变更文件、检查结果和差异摘要：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs complete-event \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id <agentId> \
  --event-ids <eventId> \
  --summary <what changed> \
  --files <comma-separated changed files> \
  --checks <comma-separated checks run> \
  --diff-summary <user-facing diff summary>
```

如果事件不存在，先确认 workspace、fileKey、nodeId 和当前 Sloth session 状态；不要凭空 ack。
