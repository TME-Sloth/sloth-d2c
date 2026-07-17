---
name: sloth-d2c-design-diff
description: "对比 Sloth/Figma 设计基准图与当前生成实现，并根据可证明的视觉差异修复 UI。在已有 implementationUrl 后进行首次生成视觉验收、收到 diff.confirmed，或用户明确要求视觉 diff、还原设计、检查长页和响应式差异时使用；普通文案、交互或局部样式标注不要使用。"
---

# Sloth D2C 视觉对比

根据 `workspace`、`fileKey`、`nodeId`，以及可选的 `eventId`、`eventBrief` 和 `implementationUrl`，定位设计基准和实现页面，完成截图、对比、修复与复验。

## 调用方式

- 首次实现完成、收到 `diff.confirmed` 或用户明确要求视觉对比时，直接派发 subAgent 使用本 skill。
- 普通文案、交互或局部样式修改不要使用本 skill。
- 无法唯一确定 baseline、`implementationUrl` 或目标会话，或者修复涉及设计意图取舍时，先询问用户。
- 让 subAgent 按下述流程处理视觉对比与修复，并等待任务完成；期间避免同时修改目标实现。环境不支持 subAgent 时，可由主 agent 执行。
- 任务包含 `eventId` 时，在检查通过后完成对应事件。

## 定位输入

1. 优先使用任务传入的 `workspace`、`fileKey` 和 `nodeId`，目标目录为项目内 `.sloth/<fileKey>/<nodeId>/`。路径不完全匹配或缺少标识时，只在该 workspace 的 `.sloth/*/*/work/state.json` 中查找；用 `eventId`、显式 `implementationUrl` 或最近会话缩小范围。存在多个候选且无法证明唯一性时停止并询问用户，不猜测。
2. 使用 `<session>/screenshots/index.png` 作为 baseline。优先使用显式 `implementationUrl`，否则读取 `<session>/work/state.json` 的 `implementationUrl`。
3. 若有 `eventId`，只读取 `<session>/work/events.jsonl` 中该事件；若调用方已传聚焦 `eventBrief`，以它为上下文但仍保持该 `eventId` 边界。若 `state.json.handledEventIds` 已包含该 id，汇报已完成并停止；不要重复修改或顺带处理其它 pending event。
4. 将当前实现截图保存到 `<session>/screenshots/implementation/design-diff[-<safeEventId>].png`。缺少 baseline 或 `implementationUrl` 时返回 blocked，不进入视觉审查，也不确认事件。

## 视觉对比与修复

1. 读取 baseline 尺寸，按同宽 viewport 使用一次性 Playwright、Puppeteer 或独立 headless 浏览器访问真实 `implementationUrl`，全页截取一张新的 candidate。每轮都覆盖为当前实现，不复用修改前截图。
2. 直接查看 baseline 和 candidate，先比较完整页面；只有长页、复杂页面或局部差异看不清时才按自然区域切片。
3. 在内部记录简洁问题清单：区域、证据、差异、严重度和状态。静态内容要求一致；动态字段只比较位置、格式、长度容错和状态契约。
4. 除非用户只要求审计，否则修复可证明的高、中严重度差异，然后重新截图复核。没有高、中严重度差异后结束，并记录剩余低风险差异。
5. 运行一个能证明改动生效的聚焦检查。

## 审查边界

- 保持 Codex 内置浏览器停留在 Sloth 拦截页。真实实现只能通过一次性 headless/local 浏览器、项目测试或源码检查访问 `implementationUrl`。
- 不要读取 Sloth 外层 DOM、iframe 包装对象、坐标点击或手动修改 iframe `src` 来代替真实实现验证。
- 只有视觉结论不确定时才补充文本 inventory、`getBoundingClientRect()`、容器关系、换行、滚动高度或源码证据。
- 不要用像素级 diff 代替 agent 视觉判断。抗锯齿、系统字体、压缩、阴影或 1–3px 微差可以标为低风险，不要反复追像素。

## 事件回写与汇报

- 若任务带 `eventId`，在视觉修复和检查成功后，使用本插件 `<plugin-root>/scripts/sloth-d2c-state.mjs complete-event` 写回摘要、变更文件、检查结果和视觉差异摘要。blocked、失败或 `eventId` 不匹配时不要 ack。
- 最终汇报已修问题、变更文件、检查结果、最终 candidate、剩余差异，以及事件是否已完成。不要贴真实业务预览 URL。
