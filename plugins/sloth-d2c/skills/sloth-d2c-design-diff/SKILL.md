---
name: sloth-d2c-design-diff
description: "用于对比 Sloth/Figma 设计截图与生成实现预览，并根据视觉差异修复生成 UI。"
---

# Sloth D2C 视觉对比

当 Codex 需要对比设计截图和生成实现，并修复视觉差异时使用此 skill。这是 Codex/脚本工作流，不是在拦截页中新建控制面板。

## 流程

1. 运行 handoff/guide 返回的 `design-diff` 命令或视觉对比命令。
2. 保持 Codex 内置浏览器停留在 Sloth 拦截页。
3. 使用 headless/local 截图工具捕获目标 `implementationUrl`。
4. 对比截图，查看 mismatch ratio 和 diff 产物，然后修复本地代码/样式。
5. 重复直到实现足够接近设计，或清楚说明剩余差异。

不要在 `design_prepare` 阶段运行视觉对比。如果还没有 `implementationUrl`，先完成第一次生成再对比。

当视觉对比关联到用户事件时，修复后对该事件运行 `complete-event`，并带上变更文件、校验项和视觉差异摘要。
