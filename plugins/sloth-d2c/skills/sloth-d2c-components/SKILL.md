---
name: sloth-d2c-components
description: 维护 Sloth D2C 组件库。用于消费 marked-components.todo.json、登记或修复 .sloth/components.json、补全组件 path/import/props/description/signature，或当用户提到组件标记、组件映射、组件库登记、marked components、components.json 时使用。
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disable: false
---

# Sloth D2C 组件库登记

核心职责是读取 `marked-components.todo.json`，结合实际写入的组件代码，合并项目根目录 `.sloth/components.json`。

## 触发场景

使用本 skill 处理以下任务：

- D2C 生成后存在 `marked-components.todo.json`
- 用户要求“把标记组件登记到组件库”
- 用户要求修复、补全或校验 `.sloth/components.json`
- 用户要求维护组件映射、组件标记、组件复用数据库

如果当前任务是完整 D2C 生成流程，先完成代码生成；写完真实组件文件后再执行本 skill 的登记步骤。

## 输入定位

优先按以下顺序定位 todo 文件：

1. 用户或上游命令明确给出的 `markedComponentsTodoPath`
2. `{chunksDir}` 的上级目录：`../marked-components.todo.json`
3. 当前项目 `.sloth/**/marked-components.todo.json` 中与本次 `fileKey` / `nodeId` 匹配的文件

如果找不到 todo 文件，检查 `.sloth/components.json` 是否存在并格式正确即可，不要凭空新增组件。

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

1. 读取 todo 文件并校验 `schemaVersion === 1`、`components` 是数组。
2. 读取项目根目录 `.sloth/components.json`；文件不存在时使用空数组。
3. 找到本次实际写入的组件文件。优先使用生成阶段已经创建的组件路径；如果没有明确映射，根据组件名在项目中搜索。
4. 从真实组件代码中提取登记信息：
   - `name`: 实际导出的组件名
   - `path`: 相对项目根目录的文件路径
   - `import`: 可直接使用的导入语句
   - `props`: 公开 props；无法可靠判断时使用空数组
   - `description`: 简短说明组件在页面中的用途
   - `signature`: todo 中的 `signature`
   - `type`: 无明确类型时填 `custom`
5. 以 `path` 为主键合并到 `.sloth/components.json`：
   - 已存在相同 `path`：更新组件信息，保留原 `id` 和 `importedAt`（如果存在）
   - 不存在：新增组件，`id` 使用 `comp_` 加 8 位小写十六进制或等价短随机串
6. 写回 `.sloth/components.json`，保持 JSON 数组格式和 2 空格缩进。

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
4. todo 中每个有真实组件产物的 `signature` 都被保留到对应条目。
5. 不存在重复 `path` 条目。

如果项目有现成 typecheck、lint 或测试，并且本次也修改了代码实现，优先运行项目的最小相关校验。

## 输出

结束时简短报告：

- 消费的 todo 路径
- 新增组件数量
- 更新组件数量
- 跳过组件及原因
- 是否通过 JSON / 去重校验

不要调用 MCP `mark_components` 工具；本 skill 的登记结果以本地 `.sloth/components.json` 为准。
