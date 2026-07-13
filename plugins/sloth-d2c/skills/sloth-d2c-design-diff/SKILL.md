---
name: sloth-d2c-design-diff
description: "对比 Sloth/Figma 设计基准图与当前生成实现，并根据可证明的视觉差异修复 UI。在已有 implementationUrl 后进行首次生成视觉验收，或用户/事件明确要求视觉 diff、还原设计、检查长页和响应式差异时使用；普通文案、交互或局部样式标注不要使用。"
---

# Sloth D2C 视觉对比

`design-diff` 命令只准备 baseline、`implementationUrl` 和截图契约；截图、视觉判断与修复由 agent 完成。不要把它扩成第二套工作流。

## 最短路径

1. 运行 handoff/guide 返回的 `commands.designDiff`，只运行一次。
2. 如果返回 `mode: blocked`，先根据 `blockers` 补齐设计 baseline 或 `implementationUrl`；不要在 `design_prepare` 阶段继续视觉对比。
3. 如果返回 `mode: ready-for-agent-capture-and-review`，按 `captureSpec` 使用一次性 Playwright、Puppeteer 或 headless 浏览器截取当前真实实现，保存到 `candidatePath`。每轮审查都截取当前实现，不复用修改前的旧截图。
4. 截图完成后直接查看 `baseline` 和 `candidatePath`，不要再次运行 `design-diff --candidate` 来确认文件。
5. 先在内部记录简洁的问题清单：区域、证据、差异、严重度和状态。除非用户只要求审计，否则不要停在问题清单，继续修复高、中严重度问题。
6. 修复后重新按 `captureSpec` 截取当前实现并复核。没有高、中严重度差异后结束；剩余低风险差异应明确记录。

## 审查边界

- 保持 Codex 内置浏览器停留在 Sloth 拦截页。真实实现只能通过一次性 headless/local 浏览器、项目测试或源码检查访问 `implementationUrl`。
- 不要读取 Sloth 外层 DOM、iframe 包装对象、坐标点击或手动修改 iframe `src` 来代替真实实现验证。
- 先比较完整页面。只有长页、复杂页面或局部差异看不清时才按自然区域切片；切片用于聚焦，不是每次都必须生成的证据包。
- 只有视觉结论不确定时才补充文本 inventory、`getBoundingClientRect()`、容器关系、换行、滚动高度或源码证据。
- 静态内容应与设计一致；动态字段比较位置、格式、长度容错和状态契约，不要求设计占位值逐字一致。
- 不要用像素级 diff 代替 agent 视觉判断。抗锯齿、系统字体、压缩、阴影或 1–3px 微差可以标为低风险，不要反复追像素。

## 完成与回写

最终汇报已修问题、变更文件、检查结果和剩余差异。若视觉对比由 work 事件触发，由调用方按照 `sloth-d2c-work` 在修复完成后执行一次 `complete-event`；本 skill 不负责定位或确认其它事件。
