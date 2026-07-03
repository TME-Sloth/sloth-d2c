---
name: sloth-d2c-loop
description: "用于继续 Sloth D2C 生成稿修改闭环。适用于用户保存生成预览标注、要求只处理某个 eventId、继续 implementation loop、处理 annotation.submitted/diff.confirmed/repair.requested 事件并写回 agent 结果。"
---

# Sloth D2C Loop

用于承接保存生成稿标注后的一句话 prompt。默认流程是事件定位、必要代码修改、一个最小检查和 `complete-event`。

## 入口

先从用户 prompt 提取可用的 `fileKey`、`nodeId`、`eventId`、`implementationUrl` 和 `agentId`。未给 `agentId` 时使用 `codex`。如果 prompt 只说“刚保存的生成稿标注”，就从本地 `.sloth` loop 状态定位最新待处理事件。

用户的继续处理 prompt 应保持轻量、像人话：可以只说处理刚保存的生成稿标注。事件正文、标注详情、处理进度和 ack 状态都以本地 `.sloth/<fileKey>/<nodeId>/loop/state.json`、`events.jsonl`、`snapshots/` 为事实源，由 agent 读取；不要要求用户把这些状态重新塞进 prompt。

`--workspace` 必须指向生成项目的真实 workspace，而不一定是当前 shell 的 cwd，也不一定是 Sloth 插件源码仓库。把 prompt 里的 workspace/cwd 视为候选，不要视为事实。

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

## 本地状态定位

处理 event 前先定位真实状态，而不是依赖长提示词：

1. 先在当前候选 workspace 运行 `workflow-handoff` 或 `annotation-workflow`。
2. 如果返回的是空初始化状态（例如 `currentVersion: 0`、`pendingEvents: []`、没有 `.sloth` 目录），或报 `Event not found: <eventId>`，不要判断为“无事可做”，也不要 ack。
3. 在本机相关 workspace 中寻找这个 event。优先检查当前 workspace、用户最近给出的实现项目、Sloth 拦截页记录的 workspace、当前 workspace 的父目录/兄弟目录；可以用 `rg "<eventId>" <candidate-root> -S --hidden -g '!node_modules' -g '!.git'` 或查找 `*/.sloth/<clean fileKey>/<clean nodeId>/loop/events.jsonl`。
4. 找到包含该 event 的 `events.jsonl` 后，以它所在项目根作为 `--workspace` 重新运行 `annotation-workflow`。项目根是 `.sloth` 的父目录。
5. 如果事件已在 `state.agents[*].processedEventIds` 中，说明已经 ack；读取最近的 `agent.result` 摘要并简短汇报“已处理/已 ack”，不要重复修改或再次 `complete-event`。
6. 只有在多个候选 workspace 都查不到该 event 时，才报告找不到状态，并列出已检查的候选位置。

## 处理规则

- 只处理当前 `eventId`，不要默认扫描或重放历史标注。
- `eventId` 是本次处理边界；即使本地还有其它 pending event，也不要顺手处理。
- 对 `annotation.submitted`，只消费事件里的 `changedCanvasAnnotations`，并且只处理 `target=implementation` 的标注。
- 默认不要读取 `loop/snapshots/*.json` 的全量内容；只有事件缺少 changed annotations 或明确需要恢复某个分组上下文时，才读取对应 snapshot。
- 对 `diff.confirmed` 或 `repair.requested`，按事件摘要修复；只有事件明确要求视觉 diff 时才进入 `sloth-d2c-design-diff`。
- 修改本地生成代码/样式后，运行一个能证明改动生效的最小检查。Sloth 拦截页必须常驻；不要把 Codex in-app browser、Browser 工具或用户正在看的 Chrome 标签页导航到 `implementationUrl`。
- 需要验证真实预览时，只能用一次性 Playwright/Puppeteer/headless 浏览器、HTTP smoke check、项目 e2e/smoke 脚本或直接读取源代码事件绑定；不要打开会挤掉 Sloth 拦截页的 Web preview/浏览器页面。
- 交互类标注优先在真实预览页用 role、label、visible text、test id 或稳定 selector 触发并断言状态变化；只有问题明确出在 Sloth 外层标注层/生成预览容器时，才检查 Sloth 页 DOM。
- 普通交互/文案/样式标注不要默认截图、不要默认跑 `design-diff` 或 `visual-compare`。
- 请求真正完成前不要 ack。
- 中间进度保持简短；不要逐条播报每个命令和尝试。最终只汇报处理的 event、改动文件、检查结果和 ack 状态，不要贴 `implementationUrl` 或其它会触发 Codex Web preview 卡片的本地预览链接。

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
