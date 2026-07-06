---
name: sloth-d2c-generate
description: "用于运行 Sloth D2C CLI、生成或刷新 chunks；适用于用户要求 D2C、Figma 转代码、生成 chunks 或继续 Sloth 代码生成。"
---

# Sloth D2C 生成

用于创建或刷新 Sloth D2C chunks/prompts。完整工作流中，先通过 `commands.prepareFirstRun` 运行 Codex handoff 模式的 `sloth d2c` 准备设计数据，再打开返回的拦截页并等待用户点击生成；首次提交通过 submit payload、`groupsData.json` 和 `chunks/` 驱动，不属于 loop，也不依赖 `workflow.submitted` 事件。首次提交是人工门禁：不要代替用户点击拦截页里的提交/生成按钮，也不要用 DOM selector、坐标点击或脚本触发表单提交。只有当用户明确要求独立/静默/无 UI 运行、跳过拦截页，或仅刷新 chunks/设计数据时，才绕过拦截页。

## 输入

需要 `fileKey` 和 `nodeId`。只有无法从当前 `.sloth` 会话推断时，才简短询问用户。

## 首选路径

在 workflow 模式下，`design_prepare` 先运行 `commands.prepareFirstRun`，确保 REST/local 设计数据已经写入目标项目 `.sloth`，然后停在拦截页等待用户提交。用户点击生成后，第一步运行/校验 chunk 生成命令。这等价于旧流程里的静默 `sloth d2c --file-key ... --node-id ... --silent --json`：准备 Codex 写代码前必须消费的 chunk prompts。

命令完成后，校验 chunk 目录：

- 有分组的提交应包含 `0.md`、`1.md` 等 group chunk 文件，以及 `codeAggregation.md` 和 `finalGenerate.md`。
- 无分组的提交可以只有 `codeAggregation.md` 和 `finalGenerate.md`。
- 如果首次提交中存在分组，但目录里只有 `codeAggregation.md` 和 `finalGenerate.md`，应视为 chunks 不完整；编码前必须结合提交 payload 或 `groupsData.json` 重新运行生成。

`absolute.html` 只用于设计快照、坐标和资源参考，不是生成实现的替代品。不要把它整页嵌入目标应用，也不要建议用 iframe、`srcDoc`、`dangerouslySetInnerHTML`、原始 HTML 字符串或缩放外壳来交付。后续编码必须消费 chunks/prompts 并落到项目组件代码。

有分组 chunk 时，后续转码建议优先交给 subagents 并行处理。生成 skill 的职责是产出并报告可派发的 group chunk 列表；主 workflow 可按每个 `0.md`、`1.md` 等文件派发 subagent。一般最多同时 6 个 subagents，超过时可分批。

后续编码必须遵循 chunks 里的提示词。group chunk 决定每个模块/组件如何实现，`codeAggregation.md` 决定组件组织、依赖和组合方式，`finalGenerate.md` 决定最终页面写入与验收要求。报告 chunks 时提醒下游 agent 按这个顺序消费，不要只读取文件名、只看摘要或选择性忽略 prompt 约束。

只有当用户明确要求 Figma 插件/本地缓存数据时才使用 `--local`。否则使用默认 REST 数据源。

## 直接 CLI

对于明确的独立 D2C 请求，运行 `sloth d2c --file-key <fileKey> --node-id <nodeId> --json`，只附加用户要求的选项，例如 `--framework`、`--depth`、`--local`、`--update` 或 `--silent`。

生成后解析 JSON 输出，记录 `chunksDir`，并确认所需 prompts 存在。有分组提交时，应存在 group chunk 文件以及 `codeAggregation.md`、`finalGenerate.md`；无分组时仍必须有 `codeAggregation.md` 和 `finalGenerate.md`。

## 收尾

报告 `chunksDir`、group chunk 数量、可派发的 group chunk 文件列表、`codeAggregation.md` 和 `finalGenerate.md` 是否存在、当前 workflow 阶段、待处理用户事件状态，以及建议的下一步。
