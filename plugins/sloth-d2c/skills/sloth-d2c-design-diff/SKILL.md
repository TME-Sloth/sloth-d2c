---
name: sloth-d2c-design-diff
description: "用于对比 Sloth/Figma 设计截图与生成实现预览，并根据视觉差异修复生成 UI。"
---

# Sloth D2C 视觉对比

当 Codex 需要对比设计截图和生成实现，并修复视觉差异时使用此 skill。视觉检查通过 Sloth 拦截页中转完成，不要让 Codex 内置浏览器直接打开真实实现页。

## 流程

1. 运行 handoff/guide 返回的 `design-diff` 命令或视觉对比命令。
2. 保持 Codex 内置浏览器停留在 Sloth 拦截页；写入 `implementationUrl` 后，通过拦截页中的生成预览查看实现。
3. 截图前优先在拦截页点击“参考”“原稿”或同义按钮，唤出 Figma 原稿/参考图；再切回生成预览，分别用 Codex 自带截图能力截取参考图和生成预览区域。
4. 不要自行编写 Playwright、Puppeteer、Selenium 或其它 headless/local 截图脚本来抓真实实现页；截图证据应来自 Codex 内置浏览器里的 Sloth 拦截页/生成预览。
5. 对比截图，查看 mismatch ratio 和 diff 产物，然后修复本地代码/样式。
6. 重复直到实现足够接近设计，或清楚说明剩余差异。

不要在 `design_prepare` 阶段运行视觉对比。如果还没有 `implementationUrl`，先完成第一次生成再对比。

当视觉对比关联到用户事件时，修复后对该事件运行 `complete-event`，并带上变更文件、校验项和视觉差异摘要。
