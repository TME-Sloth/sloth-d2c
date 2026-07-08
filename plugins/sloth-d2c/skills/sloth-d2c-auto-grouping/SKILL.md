---
name: sloth-d2c-auto-grouping
description: "执行 Sloth D2C 自动分组任务。用于处理 autoGrouping.md、autoGrouping.meta.json、autoGroupingHandoff.requiresAutoGrouping、groupsData.json、拦截页等待自动分组、AI 自动分组或要求 subAgent 生成分组文件的场景。必须使用本 skill 读取本地提示词并把最终分组 JSON 写入 groupsData.json，不要把完整分组 JSON 通过聊天返回。"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disable: false
---

# Sloth D2C 自动分组

本 skill 专门处理 Sloth D2C Skill 模式下的自动分组：读取 `.sloth/<fileKey>/<nodeId>/autoGrouping.md`，根据其中的自动分组提示词、`absolute.html` 片段和可选截图生成 `GroupData[]`，并把最终 JSON 数组写入本地 `groupsData.json`。

这个任务通常由主 agent 或拦截页触发。主 agent 只需要知道分组摘要；完整 JSON 以本地文件为准，避免长 JSON 通过聊天传递时被截断或改写。

## 入口

使用本 skill 处理以下情况：

- 用户明确提到 `$sloth-d2c-auto-grouping`
- 用户要求处理 `autoGrouping.md`、`autoGrouping.meta.json` 或 `autoGroupingHandoff`
- `workflow-handoff` / `sloth d2c --auto-grouping --json` 返回 `requiresAutoGrouping=true`
- 拦截页显示“等待 Agent 完成自动分组”，需要写入 `groupsData.json`
- 用户要求 AI 自动分组、自动划分模块、把分组结果写入本地文件

如果任务同时要求生成页面代码，先完成本 skill 的分组文件写入。只有 `groupsData.json` 校验通过后，主流程才能继续生成 chunks 或实现代码。

## 定位输入

优先从用户 prompt 或上游 JSON 中提取：

- `promptPath`: `autoGrouping.md` 的绝对路径
- `groupsDataPath`: `groupsData.json` 的绝对路径
- `screenshotPath`: 可选设计稿截图
- `rerunCommand`: 可选后续命令

如果只给了 `.sloth/<fileKey>/<nodeId>/` 目录，读取该目录下的 `autoGrouping.meta.json` 获得路径；如果 meta 缺失，则使用同目录的 `autoGrouping.md` 和 `groupsData.json`。

如果没有明确路径，只在当前项目根内查找最近修改的 `.sloth/**/autoGrouping.meta.json`。不要跨 unrelated workspace 大范围搜索。

## 执行流程

1. 读取 `autoGrouping.md` 完整内容；不要只看摘要。
2. 从 `autoGrouping.md` 的“输入资料”中确认 `groupsData` 输出路径；如果它和上游传入的 `groupsDataPath` 冲突，以 `autoGrouping.md` 明确写出的路径为准，并在最终摘要中说明。
3. 提取提示词中的 HTML，收集所有可用的 `data-id`。必要时用一个临时 Node/Python 脚本辅助解析元素 id、inline style 中的 `left/top/width/height`、文本和层级信息。
4. 如果有 `screenshotPath` 且文件存在，按需查看截图辅助判断视觉模块边界；截图只用于校正分组，不替代 HTML 中的真实元素 id。
5. 按提示词要求生成 `GroupData[]`：
   - `groupIndex`: 从 0 开始递增
   - `name`: 简短、稳定的模块名，优先 PascalCase；中文业务模块名也可以
   - `elements`: 只包含 HTML 中存在的 `data-id`
   - `rect`: 数字型 `{ left, top, width, height }`
   - `children`: 可选，直接子组的 `groupIndex`
   - `componentName`: 可选，建议组件名
   - `userPrompt`: 可选，说明该组的生成意图或交互要求
6. 写入 `groupsDataPath`，文件内容必须是裸 JSON 数组，使用 2 空格缩进，不要包裹 Markdown 代码块。
7. 重新读取 `groupsData.json` 做校验。

## 分组原则

- 覆盖页面主要视觉/业务模块，不要把每个文本、图标、背景都切成单独组。
- `elements` 宁可少而准，不要编造不存在的 id。
- 一个组应对应后续可实现的组件或页面区块，例如 Header、TabBar、ProductCard、ListSection、BottomAction。
- 有明显嵌套关系时用 `children` 表达，但不要为了“完整”构造过深树。
- 对重复卡片/列表项，优先按可复用单元或列表区域组织；如果提示词要求逐项拆分，再细分。
- `rect` 应覆盖该组主要元素的外接区域；可以从元素 bounding box 合并得到，无法精确时用合理近似值。

## 校验

写入后至少确认：

1. `groupsData.json` 是合法 JSON。
2. 顶层是数组且不为空。
3. `groupIndex` 从 0 开始，不重复。
4. 每个 `elements` 都是字符串数组，且每个 id 都能在 `autoGrouping.md` 的 HTML 中找到。
5. 每个 `rect.left/top/width/height` 都是有限数字，`width` 和 `height` 大于 0。
6. `children` 只引用存在的 `groupIndex`，不形成自引用。

如果校验失败，修正文件后重新校验。不要把未校验通过的文件留给主流程。

## 输出

最终回复只给简短摘要：

- 写入的 `groupsData.json` 路径
- 分组数量
- 主要分组名
- 校验结果
- 如果存在 `rerunCommand`，提醒主流程可以继续运行

不要在聊天中粘贴完整 `groupsData` JSON。完整结果只存在本地 `groupsData.json`。
