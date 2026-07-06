---
name: sloth-d2c-design-diff
description: "用于对比 Sloth/Figma 设计截图与生成实现预览，并根据视觉差异修复生成 UI。"
---

# Sloth D2C 视觉对比

当 Codex 需要对比设计截图和生成实现，并修复视觉差异时使用此 skill。Sloth 拦截页用于承载用户工作流和原稿/标注入口；真实实现验证应直接访问 `implementationUrl`，但不能覆盖当前 Sloth 拦截页。

## 流程

1. 运行 handoff/guide 返回的 `design-diff` 命令或视觉对比命令。
2. 保持 Codex 内置浏览器停留在 Sloth 拦截页；不要把这个页签导航到真实实现页。
3. 截图前优先在拦截页点击“参考”“原稿”或同义按钮，唤出 Figma 原稿/参考图，并截取原稿/参考证据。
4. 对真实实现截图或交互验证，使用一次性 Playwright/Puppeteer/headless 浏览器进程、HTTP smoke check、项目 e2e/smoke 脚本或源码检查打开/验证 `implementationUrl`；不要用 Codex 内置浏览器或 Browser/Chrome 工具打开真实预览，因为它们可能只有一个当前页并覆盖 Sloth 拦截页。
5. 不要用读取 Sloth 外层 DOM、iframe 包装对象、坐标点击或手动改 iframe `src` 来代替真实预览验证。真实实现应在 `implementationUrl` 页面用可访问 locator、稳定 selector、截图或项目测试脚本验证。
6. 对比截图，查看 mismatch ratio 和 diff 产物，然后修复本地代码/样式。
7. 重复直到实现足够接近设计，或清楚说明剩余差异。

不要在 `design_prepare` 阶段运行视觉对比。如果还没有 `implementationUrl`，先完成第一次生成再对比。

当视觉对比关联到用户事件时，修复后对该事件运行 `complete-event`，并带上变更文件、校验项和视觉差异摘要。
