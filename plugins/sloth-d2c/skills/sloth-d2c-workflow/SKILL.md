---
name: sloth-d2c-workflow
description: "用于通过 Sloth 拦截页、持久化 loop、快照和增量标注事件运行端到端 Sloth D2C 工作流。"
---

# Sloth D2C 工作流

用于连接 Codex 与 Sloth D2C 拦截页。拦截页是用户交互界面；第一次转码不属于 loop。Codex 环境下先运行 `commands.prepareFirstRun`，它会运行正常的 `sloth d2c` 准备 REST/local 设计数据；服务端通过 Codex 环境变量自动进入 handoff，返回 `codexHandoff.interceptorUrl`，但不会打开 Chrome 或阻塞等待提交。首次提交是人工门禁：用户必须自己在拦截页确认配置、分组和标注后点击生成。用户提交后再按 `groupsData.json` 和 `chunks/` 生成初版实现。只有写入 `implementationUrl` 后，才通过插件脚本读写目标项目的 `.sloth/<fileKey>/<nodeId>/loop/` 状态。

进入 loop 后，用户的继续处理 prompt 应尽量短，只传 `fileKey`、`nodeId`、`eventId`、`count`、`implementationUrl` 等定位字段。标注详情、当前阶段、已处理进度和 ack 状态都从目标项目本地 `.sloth/.../loop/state.json`、`events.jsonl`、`snapshots/` 读取；如果当前 cwd 没有对应状态，应先定位真实生成 workspace，再处理事件。

默认用户请求，例如“转换这个 Figma 设计”“使用 Sloth D2C”或“使用本地缓存”，仍从拦截页开始。`--local` 只作为拦截页和 D2C 命令的数据源选择。除非用户明确要求独立/静默/无 UI 运行、跳过拦截页，否则不要绕过拦截页。

## 无拦截页模式

当用户**明确**要求静默、无 UI、跳过拦截页、直接生成 chunks/代码时，workflow-handoff 应带 `--silent`：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id codex \
  --silent
```

此时返回 `interceptorMode: "silent"`。首次生成走静默路径，**不要**打开拦截页，也**不要**等待 `workflow.submitted` 人工提交：

1. 运行 `commands.firstRun`（即 `commands.rawSlothD2c`）或 `commands.generateChunks`，直接拉取设计数据并生成 chunks/prompts。
2. 校验 `chunksDir` 后，在同一回合继续按 group chunks → `codeAggregation.md` → `finalGenerate.md` 生成初版实现。
3. 首次生成阶段不要打开、保持或重新打开 Sloth 拦截页；真实预览验证仍直接访问 `implementationUrl` 或一次性自动化浏览器。
4. 只有用户后续还要进入标注 loop，或 workflow 已进入 `implementation_loop` 及之后阶段，才再打开拦截页。

静默模式与交互模式的差异：

| 场景 | 交互模式（默认） | 无拦截页模式（`--silent`） |
| --- | --- | --- |
| 首次准备 | `commands.prepareFirstRun` + 打开拦截页 + 等用户提交 | `commands.firstRun` / `commands.rawSlothD2c`，不打开拦截页 |
| 首次生成 | 基于拦截页提交后的 chunks 生成，并保持拦截页可见 | 直接消费 chunks 生成，首次生成不打开拦截页 |
| 后续 loop | 打开拦截页接收标注 | 仅在 loop 阶段按需打开拦截页 |

## 开始

直接运行 `workflow-handoff`，不要每次都主动执行 `sloth --version` 或 `sloth server start`。若返回 `slothCli.available === false`，按 `recommendedAction` 和 `commands.installSlothPnpm` / `commands.installSlothNpm` 安装 CLI，运行 `commands.verifySloth` 后重新 handoff；CLI 已可用时直接进入后续阶段。

从当前 skill 目录解析 `<plugin-root>`，然后请求当前 handoff：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --agent-id codex
```

读取 `workflowPhase`、`interceptorMode`、`recommendedAction`、`stopCondition`、`commands`、`nextEvent` 和 `eventBrief`。优先使用返回的 `commands.*`，不要手动重建脚本命令。

只有当用户明确要求 Figma 插件/本地缓存数据时才使用 `--local`。用户明确要求静默/无 UI/跳过拦截页时，workflow-handoff 必须带 `--silent`。`--dev` 或 `--dev-port` 仅用于仓库开发。

## 首次转码约定

交互模式（默认）下，第一次转码遵循 `sloth d2c` skill 流程，但在 Codex 环境里拆成非阻塞 handoff，不依赖也不创建 loop 事件：

1. 运行 `commands.prepareFirstRun`，让 `sloth d2c` 拉取 REST 数据或读取本地缓存，并写入目标项目 `.sloth/<fileKey>/<nodeId>/` 的基础设计数据。
2. 打开命令返回的 `codexHandoff.interceptorUrl`，不是预先返回的 `commands.openUrl`。
3. 停在拦截页，把控制权交给用户。不要检查提交按钮是否可用后自行点击，不要用 DOM selector、坐标点击、快捷键或脚本触发表单提交。
4. 用户在拦截页提交后，再运行/校验 Sloth D2C chunk 生成命令。
5. 优先使用 subagents 并行处理 group chunk prompts。
6. 使用最终 prompt 写入可运行的项目文件。

无拦截页模式（`interceptorMode: "silent"`）下，跳过上述 2–4 步：直接运行 `commands.firstRun` 生成 chunks，并在同一回合继续 5–6 步；首次生成阶段不要打开拦截页。

对于有分组的提交，有效 chunk 输出应包含一个或多个 group chunk 文件，例如 `0.md`、`1.md` 等，并且包含 `codeAggregation.md` 和 `finalGenerate.md`。当提交中存在分组时，只有 `codeAggregation.md` 和 `finalGenerate.md` 不够。首次实现代码开始前，必须先运行 chunk 生成并检查预期的 chunk 结构。

有分组 chunk 时，建议把 chunk 转码工作拆给 subagents：每个 subagent 只处理一个或一小组独立的 group chunk，返回组件代码、依赖资源、样式要点和风险。这样更接近旧 skill 的并行 chunk 处理方式，也能减少主 agent 串行读取所有 chunks 后独自转码的风险。一般最多同时派发 6 个 subagents；group chunks 多于 6 个时可分批派发。若当前运行环境没有可用 subagent 能力，或任务规模很小，也可以由主 agent 直接处理，并在收尾说明采用了哪种路径。

实现必须遵循 chunks 里的提示词，而不是只把 chunks 当参考资料扫一眼。处理顺序是：先按每个 group chunk（如 `0.md`、`1.md`）生成对应模块/组件，再按 `codeAggregation.md` 组织组件关系、数据流和依赖，最后按 `finalGenerate.md` 完成最终页面写入、样式整合和验收要求。不要跳过、改写或选择性忽略 chunk prompt 中的约束；如果 chunk prompt 和个人判断冲突，优先说明冲突并按 prompt 约束实现。

`absolute.html` 是设计稿快照/坐标参考，不是可交付实现。可以读取它来理解布局、文案、图片资源和元素位置，但不要把它整页塞进 React/Vue/页面里，也不要用 iframe、`srcDoc`、`dangerouslySetInnerHTML`、原始 HTML 字符串或“外层缩放壳”包装它来冒充实现。首次实现必须消费 chunks/prompts，写入目标项目的真实组件、样式、资源引用和交互代码。

## 浏览器与真实预览验证

当 workflow 要求打开或保持拦截页可见时（`interceptorMode !== "silent"` 且处于交互首次流程或 loop 阶段），优先使用 Codex 内置浏览器。如果 Browser 插件可用，加载其 `control-in-app-browser` skill。交互模式下 `design_prepare` 阶段应先运行 `commands.prepareFirstRun`，再打开命令返回的 `codexHandoff.interceptorUrl`。Codex 内置浏览器只有一个当前页面，把它视为 Sloth 拦截页专用页面。

无拦截页模式的首次生成不需要打开拦截页；以下浏览器约束主要适用于交互模式，或 loop 阶段按需打开拦截页时。

只有当 Codex 内置浏览器不可用或控制失败时，才使用会打开系统默认浏览器的 shell helper，例如 `open`、`xdg-open`、`start`、`osascript`、AppleScript 或直接调用 Chrome/Safari。`curl`/HTTP 探测可以确认可达性，但不等同于完成“打开拦截页”步骤。

Codex 内置浏览器应保持在 Sloth 拦截页，避免把用户的 Sloth 拦截页覆盖成真实实现页或本地 Vite/预览 URL。实现页的技术验证不要依赖读取 Sloth 外层 DOM、iframe 包装对象或手动改 iframe `src`；这些只证明拦截页包装层，不证明真实实现。

写入 `implementationUrl` 后，验证真实预览时直接访问 `implementationUrl`，但不要通过 Codex 内置浏览器或会复用当前 Codex 页面状态的 Browser/Chrome 工具访问：

- 改用 Playwright/Puppeteer 的一次性独立浏览器进程、HTTP smoke check、测试框架或目标项目已有 e2e/smoke 脚本。
- 如果需要真实交互验证，也在一次性自动化浏览器进程里完成；不要假设 Codex Browser/Chrome 工具有可用的新标签页或独立 context。
- 交互验证优先在真实预览页定位可访问文本、role、label、test id 或稳定 selector 并点击/断言；只在用户问题明确发生在 Sloth 外层标注/预览容器时，才检查 Sloth 页的 iframe/DOM。
- 截图证据需要两类时分开采集：Sloth 拦截页用于证明用户工作流/标注入口可用；真实预览页用于证明生成实现本身可用。

## 阶段处理

### `design_prepare`

交互模式：先运行 `commands.prepareFirstRun`。它会运行 `sloth d2c --json`，在 Codex 环境下由服务端自动进入 handoff，准备 REST/local 设计数据，同步项目 `.sloth` 基础文件，并返回 `codexHandoff.interceptorUrl`。在 Codex 内置浏览器中打开这个返回 URL。确认 Sloth D2C 页面和设计预览可见，然后结束当前回合，等待用户提交首次 workflow 后继续。

此阶段不要生成 chunks、不要生成代码、不要启动目标应用、不要写入 `implementationUrl`、不要 ack 事件，也不要运行长轮询。不要读取页面控件状态后代替用户点击“提交/生成”；即使页面已有默认配置、按钮可用，也必须停住。必须使用 `commands.prepareFirstRun` 返回的 handoff URL，不要手动打开预先拼出来的拦截页 URL。

无拦截页模式：运行 `commands.firstRun` 生成 chunks/prompts，校验 chunk 结构后在同一回合继续首次实现生成；不要打开拦截页，也不要等待用户提交。

### `initial_generation_requested` / `initial_generating`

用户已在拦截页点击生成，提交数据通过原 submit 通道返回给 Codex；此时还没有进入 `.sloth/<fileKey>/<nodeId>/loop/`。

1. 从提交 payload、`groupsData.json` 或已有 `chunks/` 理解分组和生成意图。
2. 写实现代码前先运行/校验 chunk 生成命令。这对应旧流程中 `sloth d2c --json` 的第一步，会生成/刷新 chunk prompts。
3. 校验生成的 chunk 目录。有分组提交时，应看到 `0.md`、`1.md` 等 group chunk 文件，并且有 `codeAggregation.md` 和 `finalGenerate.md`。
4. 适合并行时，为 group chunk 文件派发 subagents 转码。每个 subagent 的输入应包含对应 `{index}.md`、相关截图/资源路径、项目技术栈约束和输出格式要求。
5. 主 agent 汇总 subagent 输出，再逐条消费 `codeAggregation.md` 和 `finalGenerate.md` 生成或更新目标实现，匹配旧版 group chunk -> aggregation -> final prompt -> final write 流程。
6. 启动或识别目标应用预览。技术 smoke check 应直接访问真实预览 URL，但使用一次性 Playwright/Puppeteer/headless 浏览器、HTTP smoke check 或项目测试脚本，不要覆盖 Codex 内置浏览器里的 Sloth 拦截页。
7. 写入 `implementationUrl`。这一步才开始 loop 状态，用于后续生成稿标注、diff 和修复事件。
8. 交互模式下，重新打开或保持 Sloth 拦截页在 Codex 内置浏览器中，通过拦截页查看生成预览和接收用户标注。无拦截页模式的首次生成跳过此步。
9. 运行聚焦校验；真实实现的可访问性/交互/状态变化应在 `implementationUrl` 上验证。交互模式或 loop 阶段才用 Sloth 拦截页验证工作流容器和标注入口。

必需的 chunks/prompts 缺失时，不要仅凭截图手写第一次实现。

不要把 `absolute.html` 当成实现源直接嵌入目标应用。若发现目标代码只是加载 `.sloth/.../absolute.html`、复制整段 absolute HTML、或把静态稿包在响应式壳里，应视为未完成首次实现，继续按 chunks/prompts 转成真实项目代码。

### `implementation_loop`

打开或保持 Sloth 拦截页可见。等待用户提交生成预览标注；也可以结束当前回合，让用户稍后回来继续。

### `implementation_annotations_requested`

使用 `commands.eventBrief` 或 `annotation-workflow` 上下文处理当前事件。聚焦 `changedCanvasAnnotations`，尤其是 `target=implementation` 的标注；修改本地实现，运行一个最小必要检查，然后完成事件。普通交互、文案、间距或样式标注不要默认运行视觉对比；只有事件明确要求视觉 diff 时才使用 `sloth-d2c-design-diff`。

### `design_diff_requested` / `legacy_repair_requested`

使用事件摘要和视觉对比 helper 修复实现。如果请求来自用户事件，修复后完成该事件。

## 事件语义

- `annotation.submitted`：用户保存了生成预览标注。
- `diff.confirmed`：用户接受了视觉 diff 修复请求。
- `repair.requested`：兼容性修复事件。
- `annotation.saved`：仅表示快照/历史保存，不是默认修复请求。

只处理新的、未确认的用户事件。`complete-event` 是写入 agent 结果并确认已处理事件的常规方式。

## 收尾

报告当前阶段、`interceptorMode`、拦截页是否已打开（静默首次生成应报告未打开）、已处理事件 id、chunk 处理方式（subagent 并行或主 agent 直接处理）、`implementationUrl` 状态、变更文件和已运行校验。交互模式下 `design_prepare` 阶段，只需报告页面已打开并等待用户提交。
