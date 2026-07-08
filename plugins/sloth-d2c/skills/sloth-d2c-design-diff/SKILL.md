---
name: sloth-d2c-design-diff
description: "用于对比 Sloth/Figma 设计截图与生成实现预览，并根据视觉差异修复生成 UI。"
---

# Sloth D2C 视觉对比

当 Codex 需要对比设计截图和生成实现，并修复视觉差异时使用此 skill。Sloth 拦截页用于承载用户工作流和原稿/标注入口；真实实现验证应直接访问 `implementationUrl`，但不能覆盖当前 Sloth 拦截页。

## 流程

1. 运行 handoff/guide 返回的 `design-diff` 命令，读取 baseline、implementation 截图目标、已有截图清单和 `implementationUrl`。
2. 优先使用 `.sloth/<fileKey>/<nodeId>/screenshots/index.png` 作为设计 baseline，并优先复用 `.sloth/<fileKey>/<nodeId>/screenshots/implementation/` 下同尺寸的最新实现截图；缺少实现截图时再用一次性 Playwright/Puppeteer/headless 浏览器进程对 `implementationUrl` 截图。
3. 保持 Codex 内置浏览器停留在 Sloth 拦截页；不要把这个页签导航到真实实现页。
4. 截图前优先在拦截页点击“参考”“原稿”或同义按钮，唤出 Figma 原稿/参考图，并截取原稿/参考证据。
5. 对真实实现截图或交互验证，使用一次性 Playwright/Puppeteer/headless 浏览器进程、HTTP smoke check、项目 e2e/smoke 脚本或源码检查打开/验证 `implementationUrl`；不要用 Codex 内置浏览器或 Browser/Chrome 工具打开真实预览，因为它们可能只有一个当前页并覆盖 Sloth 拦截页。
6. 不要用读取 Sloth 外层 DOM、iframe 包装对象、坐标点击或手动改 iframe `src` 来代替真实预览验证。真实实现应在 `implementationUrl` 页面用可访问 locator、稳定 selector、截图或项目测试脚本验证。
7. 只做 agent 视觉审查：对照设计图和实现图描述可操作差异，包括结构顺序、组件位置/尺寸、文字内容、字体大小/粗细、颜色、间距、图片裁剪、滚动高度和交互状态。
8. 不要运行或要求像素级 diff 工具；本流程只依赖截图和 agent 视觉判断。
9. 重复直到实现足够接近设计，或清楚说明剩余差异。

## 视觉判断准则

- 当设计图和实现截图尺寸一致时，直接并排/逐段视觉比较。
- 当尺寸不一致时，先确认是截图视口、页面高度、rem/root font-size、DPR 或实际布局导致；不要用像素工具代替判断。
- 对移动长页，按首屏、核心内容卡片、列表区、底部模块分段检查，比全图像素百分比更有用。
- 如果只存在抗锯齿、字体渲染、图片压缩、阴影微差等低风险差异，可以标为“可接受/低优先级”，不要反复追像素。
- 如果发现文本错误、序号错误、缺失元素、模块位置明显偏移、图片裁剪错误、内容高度被截断，应优先修复代码。

不要在 `design_prepare` 阶段运行视觉对比。如果还没有 `implementationUrl`，先完成第一次生成再对比。

当视觉对比关联到用户事件时，修复后对该事件运行 `complete-event`，并带上变更文件、校验项和视觉差异摘要。
