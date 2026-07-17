---
name: sloth-d2c-workflow
description: '用于通过 Sloth 拦截页运行端到端 Sloth D2C 工作流，并在生成代码后通过持久化 work、快照和增量标注事件继续修改。'
---

# Sloth D2C 工作流

用于连接 Codex 与 Sloth D2C 拦截页。拦截页是用户交互界面；首次转码属于准备与生成阶段，写入 `implementationUrl` 后进入 work。Codex 环境下先运行 `commands.prepareFirstRun`，它会运行正常的 `sloth d2c` 准备 REST/local 设计数据并返回顶层 `interceptorUrl` 和阻塞式 `wait.command`。首次提交是人工门禁：用户必须自己在拦截页确认配置、分组和标注后点击生成。等待命令返回 `action === "consume_chunks"` 后，直接消费返回的 `chunksDir` 生成初版实现。进入 work 后，通过插件脚本读写目标项目的 `.sloth/<fileKey>/<nodeId>/work/` 状态。

进入 work 后，用户的继续处理 prompt 应尽量短，只传 `fileKey`、`nodeId`、`eventId`、`count`、`implementationUrl` 等定位字段。标注详情、当前阶段、已处理进度和 ack 状态都从目标项目本地 `.sloth/.../work/state.json`、`events.jsonl`、`snapshots/` 读取；如果当前 cwd 没有对应状态，应先定位真实生成 workspace，再处理事件。

默认用户请求，例如“转换这个 Figma 设计”“使用 Sloth D2C”或“使用本地缓存”，仍从拦截页开始。`--local` 只作为拦截页和 D2C 命令的数据源选择。除非用户明确要求独立/静默/无 UI 运行、跳过拦截页，否则不要绕过拦截页。

当用户表达“打开拦截页/工作台、标注、调提示词、组件映射、把某个页面交给 Sloth”时，启动业务页面只是前置步骤，不是最终结果。若需要先启动 Vite/Next/静态服务，可以启动业务页面；拿到可访问的业务 URL 后继续运行 `open-interceptor --workspace <project-root> --url <implementation URL>`，再按返回的 `codexBrowserOpen` 打开 Codex 内置浏览器。若用户只是要求准备服务、检查 URL、生成可交给 Sloth 的上下文，或明确不打开浏览器，则可以只返回 `open-interceptor` 的结果和下一步命令，不强制打开页面。

交互模式和 work 阶段保持 Codex 内置浏览器停在 Sloth 拦截页。真实业务页 URL 只写入 work state，用于一次性 headless/HTTP 校验；最终答复里不要贴本地 Vite URL 或 `implementationUrl`。如果需要给用户一个可打开入口，给 Sloth 拦截页入口即可。

## 自动打开与临时工作台

当用户没有提供设计稿链接、`fileKey` 或 `nodeId`，但想“把拦截页跑起来”“调提示词”“做组件映射”“基于已有实现页继续标注/修复”时，优先运行 `open-interceptor`，不要要求用户补设计稿信息：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs open-interceptor \
  --workspace <project-root> \
  --url <optional local implementation URL>
```

`open-interceptor` 会先扫描项目 `.sloth/**/work/state.json`，尝试用 `implementationUrl` 自动找出现有设计会话；命中时返回 `resolution.mode: "resolved-design-session"`，并打开该会话的 Sloth 拦截页。如果没有命中，会创建内部 synthetic session（默认 `fileKey="__workbench__"`、`nodeId="tmp-..."` 或 `--session <name>`），写入最小 `absolute.html` / `groupsData.json` / work state，并返回 `resolution.mode: "temporary-workbench"`。这表示此前实现可能不是通过 Sloth D2C 转码，但仍可以用拦截页做提示词、组件映射、实现页标注和后续 work 操作。

当 `open-interceptor` 返回 `ok: true` 和 `codexBrowserOpen.enabled === true`，且当前用户意图是打开或操作 Sloth 拦截页时，加载返回的 `codexBrowserOpen.skill`（通常是 `browser:control-in-app-browser`），显示 Codex 内置浏览器并导航到 `codexBrowserOpen.url`。如果当前意图只是准备/检查，不要强行打开；简短汇报拦截页 URL 已准备好和下一步命令即可。不要把 Codex 内置浏览器导航到业务实现页。

如果需要在最终答复中提供一个可打开入口，只提供 `codexBrowserOpen.url` 或 `interceptorUrl` 对应的 Sloth 拦截页入口；不要同时提供业务实现 URL。

如果 `open-interceptor` 返回 `action: "ask_user_intent"`，说明既没有推断出设计会话，也没有找到可打开的实现页面。此时不要继续猜、不要创建空 workbench；问用户一个问题：“你是要转代码，还是打开拦截页做标注/调提示词？转代码需要 Figma 链接或 Figma 插件里的 fileKey/nodeId；打开拦截页需要项目目录和要标注的页面 URL。” 用户选择转代码后，走正常 `prepare-interceptor` / D2C 流程；用户选择打开拦截页后，要求其提供项目目录和页面 URL，再重新运行 `open-interceptor --workspace <project-root> --url <implementation URL>`。

对用户隐藏 synthetic `fileKey/nodeId` 的细节，除非后续命令需要定位事件。最终汇报要说明是“已绑定设计稿会话”还是“临时工作台”。临时工作台不是设计稿回填，不要声称找到了 Figma 设计关系。

## 静默模式

当用户**明确**要求静默、无 UI、跳过拦截页、直接生成 chunks/代码时，workflow-handoff 应带 `--silent`：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId> \
  --silent
```

此时返回 `interceptorMode: "silent"`。首次生成走静默路径，**不要**打开拦截页，也**不要**等待 `submission.json` 人工提交：

1. 运行 `commands.firstRun`（即 `commands.rawSlothD2c`）或 `commands.generateChunks`，直接拉取设计数据并生成 chunks/prompts。
2. 校验 `chunksDir` 后，在同一回合继续消费生成提示词：有数字 group chunks 时先处理它们，再处理 `codeAggregation.md` 和 `finalGenerate.md`；没有数字 group chunks 时直接处理 `codeAggregation.md` 和 `finalGenerate.md`。
3. 首次生成阶段不要打开、保持或重新打开 Sloth 拦截页；真实预览验证仍直接访问 `implementationUrl` 或一次性自动化浏览器。
4. 只有用户后续还要进入标注 work，或 workflow 已进入 `implementation_work` 及之后阶段，才再打开拦截页。

静默模式与交互模式的差异：

| 场景      | 交互模式（默认）                                     | 静默模式（`--silent`）                                     |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| 首次准备  | `commands.prepareFirstRun` + 打开拦截页 + 等用户提交 | `commands.firstRun` / `commands.rawSlothD2c`，不打开拦截页 |
| 首次生成  | 基于拦截页提交后的 chunks 生成，并保持拦截页可见     | 直接消费 chunks 生成，首次生成不打开拦截页                 |
| 后续 work | 打开拦截页接收标注                                   | 仅在 work 阶段按需打开拦截页                               |

## 开始

默认交互首次流程直接运行 `prepare-interceptor`，不要先运行 `workflow-handoff`、不要主动执行 `sloth --version`、不要启动 `sloth server start`。`prepare-interceptor` 会自己判断当前阶段、检查 Sloth CLI、完成首次准备，并返回真正需要打开的顶层 `interceptorUrl`。

从当前 skill 目录解析 `<plugin-root>`，然后准备拦截页：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs prepare-interceptor \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId>
```

读取 `ok`、`action`、`interceptorUrl`、`codexBrowserOpen` 和 `wait`。当 `ok === true` 且 `action === "open_browser_and_wait"` 时，立即按 `codexBrowserOpen` 打开 Codex 内置浏览器，然后执行 `wait.command`。该命令会阻塞到返回 `handle_subagent_task`、`consume_chunks` 或 `error`；没有业务超时，也不要手工扫描 `.sloth` 文件。

### Agent 等待协议

- `wait.command` 存活即表示当前 Agent 正在监听；连接结束即表示没有活跃监听。不向 `state.json` 写监听状态，也不创建额外状态文件。
- 返回 `action === "handle_subagent_task"` 时，按 `task.skill` 派发 `task.path`。成功后校验产物并删除任务文件，再重新执行同一个 `wait.command`；失败时保留任务文件并报告，不要立即重入造成重复任务。
- 返回 `action === "consume_chunks"` 时直接消费 `chunksDir`；返回 `action === "error"` 或 `ok === false` 时报告 `error` 并停止。
- Agent 主动离开等待时终止 CLI 即可。首次配置阶段不根据 waiter 状态复制续跑提示词；进入 work 阶段后，页面事件未交付给活跃 waiter 时才复制并提示用户粘贴。
- 用户粘贴续跑提示词后，重新执行原 `wait.command`。任务或提交先持久化、后尝试交付，所以已发生的事件会立即返回，不会丢失。

如果返回 `action === "install_sloth_cli"`，按返回的 `command` 安装后重新运行 `prepare-interceptor`。如果返回 `action === "handle_pending_event"` 或 `action === "continue_existing_workflow"`，说明已经不是首次准备阶段，改按返回的 `workflowPhase` / `eventBrief` 继续后续生成或 work。

后续事件处理、显式继续 work 或排查状态时，才运行 `workflow-handoff`：

```bash
node <plugin-root>/scripts/sloth-d2c-state.mjs workflow-handoff \
  --workspace <project-root> \
  --file-key <fileKey> \
  --node-id <nodeId>
```

读取 `workflowPhase`、`interceptorMode`、`recommendedAction`、`stopCondition`、`commands`、`codexBrowserOpen`、`nextEvent` 和 `eventBrief`。优先使用返回的 `commands.*` 和 `codexBrowserOpen`，不要手动重建脚本命令或临时发明浏览器打开流程。

只有当用户明确要求 Figma 插件/本地缓存数据时才使用 `--local`。用户明确要求静默/无 UI/跳过拦截页时，workflow-handoff 必须带 `--silent`。`--dev` 或 `--dev-port` 仅用于仓库开发。

## 首次转码约定

交互模式（默认）下，首次转码遵循 `sloth d2c` skill 流程。Codex 环境下有内置浏览器时，可以在内置浏览器打开拦截页：

1. 运行 `prepare-interceptor`，让它执行首次 `sloth d2c` 准备、拉取 REST 数据或读取本地缓存，并写入目标项目 `.sloth/<fileKey>/<nodeId>/` 的基础设计数据。
2. 按 `codexBrowserOpen` 打开命令返回的顶层 `interceptorUrl`，不是预先返回的 `commands.openUrl`。
3. 保持浏览器停在拦截页，把页面控制权交给用户，然后立即执行返回的 `wait.command`。不要检查提交按钮是否可用后自行点击，不要用 DOM selector、坐标点击、快捷键或脚本触发表单提交。
4. 等待命令返回 `action === "consume_chunks"` 后直接消费 `chunksDir` 并进入首次生成，无需用户回复“继续”；返回 `action === "error"` 时读取 `error` 并停止。
5. 如果生成了数字 group chunk prompts，优先使用 subagents 并行处理它们。
6. 使用最终 prompt 写入可运行的项目文件。

### 处理等待事件

交互模式下，Agent 只消费 `wait.command` 返回的 action，不手工扫描 `.sloth` 目录作为轮询目标：

1. 返回 `action === "handle_subagent_task"` 时，确认 `task.path` 的 frontmatter 中 `status: pending`，按 `task.skill` 派发聚焦 subagent，并把该路径交给它。
2. subagent 完成后，只重新读取它声明的本地产物，例如 `groupsData.json` 或项目根 `.sloth/components.json`；不要在主上下文展开 task 正文里的大提示词。任务成功后对应 `subAgentTask-*.md` 必须被删除；失败则保留用于重试。
3. `groupsData.json` 只表示已有分组数据，不表示用户已经确认提交；没有 `submission.json` 时不要生成 chunks 或代码。
4. `submission.json` 仍是持久化的首次提交结果，但流程以 `action === "consume_chunks"` 为入口；收到后直接进入首次实现。`action === "error"` 携带错误信息并终止本轮。
5. 等待命令不设业务超时。处理完任务后重新执行同一个命令继续阻塞；如果 Agent 主动停止等待，直接终止 CLI。首次配置阶段页面不根据 waiter 状态复制 Prompt；进入 work 阶段后，事件未交付给活跃 waiter 时才复制续跑提示词并提示用户粘贴。

静默模式（`interceptorMode: "silent"`）下，跳过上述 2–4 步：直接运行 `commands.firstRun` 生成 chunks，并在同一回合继续 5–6 步；首次生成阶段不要打开拦截页。

首次实现按顺序消费已有 prompts：先处理数字 group chunk 文件，例如 `0.md`、`1.md`，再处理 `codeAggregation.md` 和 `finalGenerate.md`。交互模式在 `submission.json` 提交完成后直接进入这一步；静默模式由 `commands.firstRun` 生成 prompts 后进入。

如果用户在 Skill/拦截页路径启用了“自动分组 / AI 分组”，并收到 `action === "handle_subagent_task"` 且 `task.skill === "sloth-d2c-auto-grouping"`，不要把自动分组细节写在本 workflow 里，也不要把任务提示词全量读入主上下文。把 `task.path` 交给聚焦 subagent 使用 `$sloth-d2c-auto-grouping` 处理。主 agent 只重新读取本地 `groupsData.json` 确认结果；任务成功后必须删除对应 `subAgentTask-autoGrouping-*.md`，失败则保留用于重试。拦截页会自动读取结果并反填；静默首次生成路径则在文件写入后执行返回的 `resumeCommand` 生成 chunks。

有数字 group chunk 时，建议把 chunk 转码工作拆给 subagents：每个 subagent 只处理一个或一小组独立的 group chunk，返回组件代码、依赖资源、样式要点和风险。一般最多同时派发 6 个 subagents；group chunks 多于 6 个时可分批派发。若当前运行环境没有可用 subagent 能力，或任务规模很小，也可以由主 agent 直接处理，并在收尾说明采用了哪种路径。

实现必须遵循 chunks 里的提示词，而不是只把 chunks 当参考资料扫一眼。处理顺序是：如果存在数字 group chunk（如 `0.md`、`1.md`），先生成对应模块/组件；然后按 `codeAggregation.md` 组织组件关系、数据流和依赖；最后按 `finalGenerate.md` 完成最终页面写入、样式整合和验收要求。不要跳过、改写或选择性忽略 chunk prompt 中的约束；如果 chunk prompt 和个人判断冲突，优先说明冲突并按 prompt 约束实现。

如果 chunk 目录的上级目录存在 `tasks/subAgentTask-componentRegistration-*.md`，首次实现写入真实组件后必须消费组件登记任务。把 task 文件交给 `$sloth-d2c-components`，用实际写入的组件名、路径、import、props 和描述合并项目根目录 `.sloth/components.json`，并保留 task 中的 `signature` 供后续截图匹配。任务成功后必须删除对应 `subAgentTask-componentRegistration-*.md`；失败则保留用于重试。组件登记通过本地文件完成，不调用 MCP `mark_components` 工具。

`absolute.html` 是设计稿快照/坐标参考，不是可交付实现。可以读取它来理解布局、文案、图片资源和元素位置，但不要把它整页塞进 React/Vue/页面里，也不要用 iframe、`srcDoc`、`dangerouslySetInnerHTML`、原始 HTML 字符串或“外层缩放壳”包装它来冒充实现。首次实现必须消费 chunks/prompts，写入目标项目的真实组件、样式、资源引用和交互代码。

## 浏览器与真实预览验证

当 workflow 返回 `codexBrowserOpen.enabled === true` 时，视为 Sloth 已内置要求打开 Codex 内置浏览器。必须加载 `codexBrowserOpen.skill`（通常是 `browser:control-in-app-browser`），选择 `codexBrowserOpen.target`（通常是 `iab`），显示浏览器并导航到 `codexBrowserOpen.url` 或 `codexBrowserOpen.urlSource` 指向的运行时 URL。交互模式下 `design_prepare` 阶段应先运行 `commands.prepareFirstRun`，再用返回结果里的顶层 `interceptorUrl` 导航；不要再做额外工具发现，也不要把 `commands.openUrl` 当作最终 URL。Codex 内置浏览器只有一个当前页面，把它视为 Sloth 拦截页专用页面。

静默模式的首次生成不需要打开拦截页；以下浏览器约束主要适用于交互模式，或 work 阶段按需打开拦截页时。

只有当 `codexBrowserOpen` 缺失、Codex 内置浏览器不可用或控制失败时，才使用本机 shell helper 打开拦截页，例如 `open`、`xdg-open`、`start`、`osascript`、AppleScript 或直接调用 Chrome/Safari。`curl`/HTTP 探测可以确认可达性，但不等同于完成“打开拦截页”步骤。

Codex 内置浏览器应保持在 Sloth 拦截页，避免把用户的 Sloth 拦截页覆盖成真实实现页或本地 Vite/预览 URL。实现页的技术验证不要依赖读取 Sloth 外层 DOM、iframe 包装对象或手动改 iframe `src`；这些只证明拦截页包装层，不证明真实实现。

最终答复同样要保持这个边界：交互模式和 work 阶段不要输出裸 `localhost`/`127.0.0.1` 业务预览地址，也不要用 Markdown 链接指向业务实现页。若必须说明真实页状态，只写“真实预览已写入 Sloth 拦截页/work state 并通过校验”，不要附 URL。

写入 `implementationUrl` 后，验证真实预览时直接访问 `implementationUrl`，但不要通过 Codex 内置浏览器或会复用当前 Codex 页面状态的 Browser/Chrome 工具访问：

- 改用 Playwright/Puppeteer 的一次性独立浏览器进程、HTTP smoke check、测试框架或目标项目已有 e2e/smoke 脚本。
- 如果需要真实交互验证，也在一次性自动化浏览器进程里完成；不要假设 Codex Browser/Chrome 工具有可用的新标签页或独立 context。
- 交互验证优先在真实预览页定位可访问文本、role、label、test id 或稳定 selector 并点击/断言；只在用户问题明确发生在 Sloth 外层标注/预览容器时，才检查 Sloth 页的 iframe/DOM。
- 截图证据需要两类时分开采集：Sloth 拦截页用于证明用户工作流/标注入口可用；真实预览页用于证明生成实现本身可用。

## 阶段处理

### `design_prepare`

交互模式：先运行 `prepare-interceptor`。它会运行 `sloth d2c --json`，准备 REST/local 设计数据，同步项目 `.sloth` 基础文件，并返回顶层 `interceptorUrl` 和 `wait`。按 `codexBrowserOpen` 在 Codex 内置浏览器中打开这个返回 URL，然后执行 `wait.command`。收到 `handle_subagent_task` 就处理、校验、删除任务并再次等待；收到 `consume_chunks` 就在同一回合直接消费 chunks 并继续首次生成；收到 `error` 就报告错误。

收到 `action === "consume_chunks"` 前不要生成 chunks、不要生成代码、不要启动目标应用、不要写入 `implementationUrl`、不要 ack 事件。等待连接本身就是监听事实，不写 `polling` / `wait` 状态，也没有业务超时。不要读取页面控件状态后代替用户点击“提交/生成”；页面已有默认配置或按钮可用也不代表已经提交。必须使用 `commands.prepareFirstRun` 返回的拦截页 URL，不要手动打开预先拼出来的拦截页 URL。

静默模式：运行 `commands.firstRun` 生成 chunks/prompts，校验 chunk 结构后在同一回合继续首次实现生成；不要打开拦截页，也不要等待用户提交。

### `initial_generation_requested` / `initial_generating`

用户已在拦截页点击生成，服务端生成 chunks 并写入 `submission.json`；此时还没有进入 `.sloth/<fileKey>/<nodeId>/work/`。

1. 从 `groupsData.json` 和已有 `chunks/` 理解分组和生成意图。
2. 写实现代码前读取提交生成的 chunk prompts。
3. 先处理数字 group chunk 文件，再处理 `codeAggregation.md` 和 `finalGenerate.md`。
4. 适合并行且存在数字 group chunk 时，为这些文件派发 subagents 转码。每个 subagent 的输入应包含对应 `{index}.md`、相关截图/资源路径、项目技术栈约束和输出格式要求。
5. 主 agent 汇总 subagent 输出，再逐条消费 `codeAggregation.md` 和 `finalGenerate.md` 生成或更新目标实现。
6. 启动或识别目标应用预览。技术 smoke check 应直接访问真实预览 URL，但使用一次性 Playwright/Puppeteer/headless 浏览器、HTTP smoke check 或项目测试脚本，不要覆盖 Codex 内置浏览器里的 Sloth 拦截页。
7. 写入 `implementationUrl`。这一步才开始 work 状态，用于后续生成稿标注、diff 和修复事件。
8. 首次实现完成后，直接派发 subAgent 使用 `sloth-d2c-design-diff` 进行视觉验收与必要修复。
9. 交互模式下，重新打开或保持 Sloth 拦截页在 Codex 内置浏览器中，通过拦截页查看生成预览和接收用户标注。静默模式的首次生成跳过此步。
10. 运行聚焦校验；真实实现的可访问性/交互/状态变化应在 `implementationUrl` 上验证。交互模式或 work 阶段才用 Sloth 拦截页验证工作流容器和标注入口。

必需的 chunks/prompts 缺失时，不要仅凭截图手写首次实现。

不要把 `absolute.html` 当成实现源直接嵌入目标应用。若发现目标代码只是加载 `.sloth/.../absolute.html`、复制整段 absolute HTML、或把静态稿包在响应式壳里，应视为未完成首次实现，继续按 chunks/prompts 转成真实项目代码。

### `implementation_work`

打开或保持 Sloth 拦截页可见。等待用户提交生成预览标注；也可以结束当前回合，让用户稍后回来继续。

### `implementation_annotations_requested`

使用 `commands.eventBrief` 或 `annotation-workflow` 上下文处理当前事件。聚焦 `changedCanvasAnnotations`，尤其是 `target=implementation` 的标注；修改本地实现，运行一个最小必要检查，然后完成事件。普通交互、文案、间距或样式标注不要默认运行视觉对比；事件明确要求视觉 diff 时直接使用 `sloth-d2c-design-diff`。

### `design_diff_requested`

直接把 `workspace`、`fileKey`、`nodeId`、`eventId` 和聚焦 `eventBrief` 交给 subAgent，使用 `sloth-d2c-design-diff` 处理。

### `repair_requested`

按事件摘要处理普通修复；`eventBrief` 明确要求视觉 diff 时，直接派发 subAgent 使用 `sloth-d2c-design-diff`。

## 事件语义

- `annotation.submitted`：用户保存了生成预览标注。
- `diff.confirmed`：用户接受了视觉 diff 修复请求。
- `repair.requested`：修复事件。
- `annotation.saved`：仅表示快照/历史保存，不是默认修复请求。

只处理新的、未确认的用户事件。`complete-event` 是写入 agent 结果并确认已处理事件的常规方式。

## 收尾

报告当前阶段、`interceptorMode`、拦截页是否已打开（静默首次生成应报告未打开）、已处理事件 id、chunk 处理方式（subagent 并行或主 agent 直接处理）、`implementationUrl` 是否已写入、变更文件和已运行校验。若 Agent 主动结束首次等待，终止等待命令即可。告知用户：没有活跃 waiter 时，页面会在任务或提交事件未交付后自动复制续跑提示词，粘贴回当前对话即可恢复。

交互模式和 work 阶段的收尾不要贴真实实现 URL 或本地 Vite URL。若要给用户一个可打开入口，只给 Sloth 拦截页 URL，并确认 Codex 内置浏览器已停在该拦截页。
