---
name: sloth-d2c-components
description: 维护 Sloth D2C 组件库。用于把用户引用的组件包/组件目录登记到 .sloth/components.json，也用于消费 marked-components.todo.json、修复组件映射、补全 path/import/props/description/signature，或当用户提到组件标记、组件映射、组件库登记、marked components、components.json 时使用。
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disable: false
---

# Sloth D2C 组件库登记

核心职责是维护项目根目录 `.sloth/components.json`。支持两种入口：

1. **组件入口**：用户在 Codex 中直接引用一个组件包、组件目录或组件文件，并调用 `/sloth-d2c-components`。此时应扫描该包/目录里的真实组件代码并登记。
2. **todo 入口**：D2C 拦截页标注的组件在生成后产出 `marked-components.todo.json`，结合实际写入的组件代码登记被标记组件。

## 触发场景

使用本 skill 处理以下任务：

- 用户直接引用组件包、组件目录或组件文件，并调用 `/sloth-d2c-components`
- 用户要求“把这个组件包登记到组件库”
- 用户要求“扫描 src/components 并登记组件”
- D2C 生成后存在 `marked-components.todo.json`
- 用户要求“把标记组件登记到组件库”
- 用户要求修复、补全或校验 `.sloth/components.json`
- 用户要求维护组件映射、组件标记、组件复用数据库

如果当前任务是完整 D2C 生成流程，先完成代码生成；写完真实组件文件后再执行本 skill 的登记步骤。

## 输入定位

先判断用户是否显式引用了组件包、组件目录或组件文件：

- 如果引用的是目录，把它视为组件包/组件目录入口。
- 如果引用的是 `package.json`、入口文件、组件源码文件，把其所在包或目录视为组件入口。
- 如果引用的是 `.sloth/<fileKey>/<nodeId>/...` 这类 D2C 工作目录，再按 todo 入口定位。
- 如果用户同时提供组件包和 todo，优先使用组件包里的真实导出与源码信息，todo 只补充 `signature`、建议名和 D2C 上下文。

组件包入口的扫描顺序：

1. 读取 `package.json`，识别 `name`、`main`、`module`、`exports`、`types`。
2. 查找公开入口：`src/index.*`、`index.*`、`src/components/**`、`components/**`。
3. 只登记有明确导出的组件；不要把纯工具函数、样式文件、demo、story、test 当成组件。
4. 从真实源码提取组件名、导入方式、props 类型和简短用途说明。
5. 若组件包不在当前项目根目录内，`path` 使用用户引用路径下可稳定定位的相对路径；`import` 优先使用包名导入，其次使用项目可用别名或相对路径。

Todo 入口按以下顺序定位 todo 文件：

1. 用户或上游命令明确给出的 `markedComponentsTodoPath`
2. 用户引用的 `.sloth/<fileKey>/<nodeId>/` 工作目录下的 `marked-components.todo.json`
3. `{chunksDir}` 的上级目录：`../marked-components.todo.json`
4. 当前项目 `.sloth/**/marked-components.todo.json` 中与本次 `fileKey` / `nodeId` 匹配的文件

如果没有 todo 但有明确组件包入口，继续扫描组件包并登记；不要因为缺少 `marked-components.todo.json` 停止。只有在既没有 todo、也没有明确组件包/组件目录/组件文件时，才只检查 `.sloth/components.json` 是否存在并格式正确，不要凭空新增组件。

## Todo 文件格式

`marked-components.todo.json` 的结构：

```json
{
  "schemaVersion": 1,
  "fileKey": "figma-file-key",
  "nodeId": "1:2",
  "generatedAt": "2026-07-07T00:00:00.000Z",
  "components": [
    {
      "name": "SuggestedComponentName",
      "signature": "screenshot-hash-or-filename",
      "groupIndex": 0,
      "groupName": "SuggestedComponentName"
    }
  ]
}
```

`name` 和 `groupName` 是建议名。最终登记时以实际写入的组件名为准。

## 登记流程

1. 明确本次输入类型：组件包入口、todo 入口，或二者都有。
2. 读取项目根目录 `.sloth/components.json`；文件不存在时使用空数组。
3. 取得本次要登记的真实组件文件：
   - 组件包入口：从包入口、导出表和组件目录中扫描。
   - todo 入口：优先使用生成阶段已经创建的组件路径；如果没有明确映射，根据 todo 组件名在项目中搜索。
4. 从真实组件代码中提取登记信息：
   - `name`: 实际导出的组件名
   - `path`: 相对项目根目录的文件路径
   - `import`: 可直接使用的导入语句
   - `props`: 公开 props；无法可靠判断时使用空数组
   - `description`: 简短说明组件在页面中的用途
   - `signature`: todo 或组件包元信息中有证据时填写；没有则省略
   - `type`: 无明确类型时填 `custom`
5. 以 `path` 为主键合并到 `.sloth/components.json`：
   - 已存在相同 `path`：更新组件信息，保留原 `id` 和 `importedAt`（如果存在）
   - 不存在：新增组件，`id` 使用 `comp_` 加 8 位小写十六进制或等价短随机串
6. 写回 `.sloth/components.json`，保持 JSON 数组格式和 2 空格缩进。
7. 如果本次消费了 `marked-components.todo.json` 且合并成功，删除该 todo 文件；如果合并失败，保留 todo 方便排查和重试。

## 组件条目格式

写入 `.sloth/components.json` 的条目应符合：

```json
{
  "id": "comp_ab12cd34",
  "name": "RealComponentName",
  "type": "custom",
  "path": "src/components/RealComponentName.tsx",
  "import": "import { RealComponentName } from './components/RealComponentName'",
  "props": [
    {
      "name": "title",
      "type": "string",
      "required": false,
      "description": "标题文本"
    }
  ],
  "description": "页面中的可复用卡片组件",
  "signature": "screenshot-hash-or-filename"
}
```

只写有证据支持的 props。不要为了显得完整编造复杂 props。

## Import 规则

优先生成与项目现有风格一致的 import：

- 组件包有包名且项目可直接依赖时，优先写包名导入，例如 `import { Button } from '@scope/ui'`
- 项目使用别名时，沿用别名，例如 `@/components/Card`
- 项目使用相对路径时，写成从最终页面文件可导入的路径
- 组件为 default export 时使用 `import ComponentName from '...'`
- 组件为 named export 时使用 `import { ComponentName } from '...'`

不确定导入方式时，读取组件文件确认 export 形式。

## 验证

完成登记后至少做以下检查：

1. `.sloth/components.json` 是合法 JSON。
2. 顶层是数组。
3. 每个新增或更新条目包含 `id`、`name`、`type`、`path`、`import`、`props`。
4. todo 中每个有真实组件产物的 `signature` 都被保留到对应条目；组件包入口没有 `signature` 时允许省略。
5. 不存在重复 `path` 条目。

如果项目有现成 typecheck、lint 或测试，并且本次也修改了代码实现，优先运行项目的最小相关校验。

## 输出

结束时简短报告：

- 消费的 todo 路径
- 扫描的组件包/组件目录路径
- 新增组件数量
- 更新组件数量
- 跳过组件及原因
- 是否删除已消费的 todo
- 是否通过 JSON / 去重校验

不要调用 MCP `mark_components` 工具；本 skill 的登记结果以本地 `.sloth/components.json` 为准。
