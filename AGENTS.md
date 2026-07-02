# lmcode 开发指南

> **项目所有者 / 唯一开发者**：Lyin01 (Liumir)。当前与你对话的人就是 LMcode 的创建者和维护者。GitHub 认证通过 git credential store 配置，仓库位于 `E:\project for cc\lmcode` —— 需要时可申请推送权限。
>
> 本指南涵盖整个 monorepo。标记为 **apps/lmcode** 的章节仅限该应用；其余内容适用于所有工作区包。

## 目录

1. [工作区概览](#工作区概览)
2. [代码质量与风格](#代码质量与风格)
3. [TUI 清理](#tui-清理)
4. [测试指南](#测试指南)
5. [命令与工作流](#命令与工作流)
6. [TUI 文件布局 (apps/lmcode)](#tui-文件布局-appslmcode)
7. [模块职责 (apps/lmcode)](#模块职责-appslmcode)
8. [LmcodeTUI 内部章节 (apps/lmcode)](#lmcodetui-内部章节-appslmcode)
9. [新功能应该放哪 (apps/lmcode)](#新功能应该放哪-appslmcode)
10. [TUI 编码规范 (apps/lmcode)](#tui-编码规范-appslmcode)
11. [如何设置主题 (apps/lmcode)](#如何设置主题-appslmcode)
12. [MCP (apps/lmcode)](#mcp-appslmcode)
13. [斜杠命令 (apps/lmcode)](#斜杠命令-appslmcode)
14. [Agent-Core 机制](#agent-core-机制)
15. [通用编码要求](#通用编码要求)

---

## 工作区概览

### 包（Packages）

| 包名 | 路径 | 职责 |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `agent-core` | `packages/agent-core/` | Agent 运行时：轮次循环、会话、工具、MCP 客户端、压缩（compaction）、记忆、目标/狼群 |
| `ltod` | `packages/ltod/` | 多供应商 LLM 客户端，支持流式输出 |
| `jian` | `packages/jian/` | 执行环境抽象（文件系统、进程、沙箱） |
| `node-sdk` | `packages/node-sdk/` | Node.js SDK（`LmcodeHarness`、`Session`），供应用层使用 |
| `memory` | `packages/memory/` | 跨会话的记忆存储与评分 |
| `config` | `packages/config/` | 平台配置、身份标识、模型别名 |
| `migration-legacy` | `packages/migration-legacy/` | 旧数据迁移 —— **已弃用，v1.0 移除**（日落计划见该包 README） |
| `apps/lmcode` | `apps/lmcode/` | CLI 和终端 UI 应用（`lm` 命令） |

### 术语说明

- 当用户说 **"agent"** 或 **"session"** 时，指的是 `packages/agent-core` 运行时（`Session`、`Agent`、轮次循环），而不是 AI 助手本身。
- **"app"** / **"TUI"** / **"CLI"** 均指 `apps/lmcode`。
- **"SDK"** 指从 `packages/node-sdk` 导出的 `@lmcode-cli/lmcode-sdk`。
- **"LLM layer"** 指 `packages/ltod`。
- **"memory"** 指 `packages/memory` 中的任务经验记录。

### 跨包导入规则

- `apps/lmcode` **只能通过 `@lmcode-cli/lmcode-sdk`** 使用核心功能。禁止在应用代码中直接导入 `@lmcode-cli/agent-core`。
- `packages/agent-core` 不能依赖 `apps/lmcode`。
- 优先使用包内局部导入。跨包时，从包公开的 `index.ts` 或文档中说明的子路径导入。
- 对于 Node.js 内置模块，优先使用命名空间导入：`import * as fs from 'node:fs/promises'`、`import * as path from 'node:path'`。

---

## 代码质量与风格

### TypeScript

- 避免使用 `any`。如果无法避免，请添加简短注释说明原因。
- **不要**在新代码中使用 `ReturnType<>`，优先使用显式类型名称。现有用法（如计时器 ID）在修改时应迁移为命名别名。
- 避免内联类型导入，如 `import('pkg').Type` 或 `import('./module').Type`。使用顶层导入。
- 可选对象属性：直接传递 `undefined` —— 不要使用条件展开（conditional spread）。
- 只有一个参数的内部方法不应为了风格统一而转为 options 对象。
- 除了包自身的公开 `index.ts` 外，内部的 `index.ts` barrel 导出应优先使用 `export * from './module'`。

### 类

- 当前代码库使用 `private readonly` 表示内部类状态。在一个文件内保持此风格，不要在同一组件中混用 `private readonly` 和原生 `#private` 字段。
- 构造函数参数属性是可以的（例如 `constructor(private readonly host: Host)`）。
- 外部可访问的成员不需要 `public` 关键字。

### Promises 与异步

- 新代码在能简化控制流时优先使用 `Promise.withResolvers()`。不要仅为风格原因重构已有的 `new Promise` 代码。
- 在 Bun 环境下，优先使用 `await Bun.sleep(ms)` 而不是 `new Promise(r => setTimeout(r, ms))`。

### 提示词与静态文案

- 工具描述和系统提示词放在使用它们的代码旁边的 `.md` 文件中。
- 通过项目的原始文本加载器导入，例如：
  ```ts
  import DESCRIPTION from './tool.md';
  ```
  不要将多行提示词内联为模板字符串。
- UI 文案、选项标签、帮助文本和对话框标题应放在使用它们的组件或命令旁边。不要集中到一个全局"文案常量"模块中。

### 日志

- **绝不要在 TUI 组件或渲染路径中使用 `console.log` / `console.warn` / `console.error`** —— 这会破坏终端渲染。
- `console.log` 仅在纯 CLI、非交互式流程中允许（例如 `channel-setup.ts`）。
- 运行时错误应通过记录器（logger）处理或写入应用日志文件，而不是打印到 stdout/stderr。
- `apps/lmcode/src/tui/tui-state.ts` 中现有的 `console.error` 应视为遗留逃生口，不应作为模式复制。

### 生成的文件

- `dist/`、`.turbo/` 和构建产物是自动生成的。切勿手动编辑。
- `packages/agent-core/src/tools/builtin/**/*.md` 是手写的提示词文件，可直接编辑。
- `packages/migration-legacy/` 已弃用，不要添加新的迁移逻辑。

---

## TUI 清理

TUI 中渲染的所有文本都必须经过清理。原始内容——文件内容、错误消息、工具输出、路径——会破坏终端渲染：制表符产生视觉空洞，长行溢出，绝对路径暴露主目录。

**规则：**

- **制表符 → 空格**：通过 `replaceTabs()`（来自 `@earendil-works/pi-tui` 或本地 render-utils）。
- **截断**行：使用 `truncateToWidth()` / `ui.truncate()`。复用已有的 `TRUNCATE_LENGTHS` 常量，不要自创临时数字。
- **缩短路径**：使用 `shortenPath()`（将 home 替换为 `~`）。
- **应用于所有渲染路径**，而不仅是正常路径：
  - 成功输出（文件预览、命令输出、搜索结果）。
  - **错误信息**——这些通常嵌入了文件内容（例如补丁失败消息包含不匹配的行）。如果消息包含文件内容，请运行 `replaceTabs()` 并截断。
  - Diff 内容（添加和删除的行）。
  - 流式预览。

**流式工具预览：** 工具调用预览可能有多个渲染路径。如果你添加了仅预览字段或依赖部分流式参数，请更新所有路径——而不仅仅是最终的渲染器。在任何预览更改后，验证实时流式和重建的转录本路径。

---

## 测试指南

测试系统对外暴露的契约——而不是最容易断言的内部分实现细节。

- 每个新测试必须捍卫一个**具体的、外部可观察的契约**：行为、输出形状、状态转换、错误映射或易回归的解析边界。如果你说不出这个契约是什么，就不要添加这个测试。
- 不要出现占位测试、同义反复或"代码运行了"的断言（`expect(true).toBe(true)`、裸 `not.toThrow()`、非空字符串检查、长度增长检查、没有语义断言的"提示词存在"检查）。
- 优先选择契约级别的测试而不是实现细节。避免断言内部辅助函数的连接、字段赋值、单例身份、偶然的顺序、提示词模板或透传选项转发，除非另一个组件依赖于那个具体细节。
- 不要跨抽象层重复覆盖。如果集成测试已经证明了某个行为，就删除通过 mock 重述该行为的较窄单元测试。
- 测试**必须对整个测试套件安全**，而不仅仅是对单个文件安全。当存在更窄的接缝时，不要对 `Bun.*`、`process.platform`、`process.env` 或 `Bun.env` 进行长期的文件级全局变更。优先使用每个测试的 `vi.spyOn(...)` 结合 `afterEach` 中的 `vi.restoreAllMocks()`。
- **绝不使用 `mock.module()`**。它会改变全局模块注册表并泄漏到其他文件。改为在导入的模块对象上使用 `spyOn`。
- 对于生命周期/有状态代码，优先为每个不变量或转换写一个测试，而不是为同一转换中每个字段写几个微小测试。
- 对于错误处理，触发真实的失败路径并断言暴露的契约——不要直接实例化错误类或检查内部元数据。
- 冒烟测试仅在它能捕获到较窄测试无法捕获的失败模式时才可以接受。仅"包能启动"或"命令能运行"是不够的。
- 仅当下游代码解析或依赖精确的字节时，才断言精确的字符串、顺序和格式。否则断言语义内容。
- 编译时保证 → 类型检查/类型测试，而不是运行时占位符。
- 不要为微小低风险的变更添加测试，除非它们保护了一个真实的契约或修复了一个易回归的边缘情况。
- 优先对修改区域进行集中式的包内验证。

### 测试放置 (apps/lmcode)

- 组件行为测试放在对应组件测试的旁边。
- 命令解析测试放在 `test/tui/commands/` 下。
- reverse-rpc 测试放在 `test/tui/reverse-rpc/` 下。
- 纯工具函数测试放在对应工具测试的旁边。
- 不要仅仅为了一个小功能而创建通用的 `some-feature.test.ts`。

---

## 命令与工作流

- **除非明确要求，绝不提交、推送或发布。**
- 类型检查：`bun run typecheck`（按包）或工作区检查命令。
- 测试：`bunx vitest run`（按包）或 `bun run test`（工作区）。
- 构建：`bun run build`。
- 不要直接运行裸 `tsc`。

---

## TUI 文件布局 (apps/lmcode)

`apps/lmcode` 是终端 UI / CLI 应用。入口链如下：

`src/main.ts` -> `src/cli/commands.ts` -> `src/cli/run-shell.ts` -> SDK `LmcodeHarness` -> `src/tui/lmcode-tui.ts`

主要目录：

- `src/constant/`：CLI/TUI 共享的非复制常量——产品、协议、路径、终端控制、更新等。
- `src/cli/`：命令行参数、子命令和 CLI 启动。
- `src/tui/`：交互式终端 UI。
- `src/tui/lmcode-tui.ts`：TUI 主装配器，负责将状态、布局、编辑器、会话、SDK 事件和对话框串联在一起。
- `src/tui/commands/`：斜杠命令定义、解析、排序和动态技能命令生成。
- `src/tui/components/`：pi-tui 组件，按 UI 类型组织。
- `src/tui/constant/`：跨 TUI 模块复用的非复制常量——符号、终端序列、渲染尺寸、流式参数匹配规则等。
- `src/tui/components/chrome/`：持久化 UI 框架——页脚、待办事项面板、欢迎页、加载器、设备码。
- `src/tui/components/dialogs/`：选择器、审批面板、问题弹窗和设置弹窗，临时替换编辑器。
- `src/tui/components/editor/`：自定义输入框和文件提及提供器。
- `src/tui/components/media/`：图片、diff、代码高亮及其他媒体展示。
- `src/tui/components/messages/`：转录本中的消息块——助手、用户、工具调用、思考过程、用量、子 agent 等。
- `src/tui/components/panes/`：右侧/活动区域面板，如活动面板和队列面板。
- `src/tui/reverse-rpc/`：适配层，将 SDK 审批/问题回调桥接到 UI。
- `src/tui/theme/`：主题、颜色令牌、样式帮助器和 pi-tui markdown 主题。
- `src/tui/utils/`：TUI 独有工具函数。
- `src/utils/`：应用级工具——剪贴板、git、历史记录、图片、进程、用量等。

---

## 模块职责 (apps/lmcode)

- `cli` 仅负责解释命令行输入、组装启动参数并调用 TUI。不要将 TUI 交互逻辑放入 CLI 中。
- `LmcodeTUI` 负责协调，不积累复杂的业务规则。可以独立测试的新逻辑应拆分到 `commands`、`components`、`reverse-rpc` 或 `utils` 中。
- `commands` 仅拥有斜杠命令声明、解析和解析结果类型。实际执行可以从 `LmcodeTUI` 调度，但复杂逻辑应继续向下沉淀。
- `components` 仅处理展示和局部交互，不得直接调用 SDK，也不得直接读写会话状态。
- `reverse-rpc` 将 SDK 审批/问题请求转换为 UI 面板/对话框所需的数据形状，并将用户的选择转换回 SDK 响应。
- `theme` 是颜色和样式的唯一真相来源。组件不得绕过主题系统直接使用 chalk 命名颜色。
- `utils` 持有不依赖 UI 状态的工具函数。需要 `TUIState` 或组件实例的逻辑不能放在应用级 `src/utils` 下。
- 恢复重放编排位于 `LmcodeTUI` 的 `Session Replay` 章节，因为它有意驱动与实时事件相同的状态渲染钩子。无状态的重放解析、限制和投影帮助器属于 `src/tui/utils/message-replay.ts`。
- `apps/lmcode` 只能通过 `@lmcode-cli/lmcode-sdk` 使用核心功能。不要在应用代码中直接导入 `@lmcode-cli/agent-core`。

---

## LmcodeTUI 内部章节 (apps/lmcode)

`src/tui/lmcode-tui.ts` 体积较大。修改时，请将代码放入现有的职责章节——不要只图方便随便放。

- **类型与状态创建**：`LmcodeTUIStartupInput`、`TUIState`、`createInitialAppState`、`createTUIState`。在添加新的全局 UI 状态之前，先判断它是否真的属于 `TUIState`。
- **启动辅助**：斜杠命令、自动补全、技能命令、输入历史。
- **生命周期**：`start`、`init`、`stop`。它们只处理启动/关闭顺序——不要把功能实现塞进去。
- **布局与编辑器**：`buildLayout`、`setupEditorHandlers`、外部编辑器、剪贴板图片、退出快捷键。
- **用户输入**：`handleUserInput`、`executeSlashCommand`、`handleBuiltInSlashCommand`、`sendNormalUserInput`。
- **发送与排队**：`enqueueMessage`、`sendMessageInternal`、`sendMessage`、`steerMessage`、`finalizeTurn`。
- **会话管理**：创建、恢复、切换、关闭、同步运行时状态、订阅会话事件。
- **会话重放**：填充恢复快照、通过实时渲染钩子驱动重放记录、清理临时重放状态。
- **事件路由**：`handleEvent` 仅负责分发；具体事件进入对应的 `handleXxx`。
- **流式渲染**：助手的增量内容、思考过程、工具调用、工具结果、压缩、子 agent、后台 agent。
- **转录本**：`createTranscriptComponent`、`appendTranscriptEntry`、读/工具/agent 分组聚合。
- **活动 / 队列 / 页脚**：`updateActivityPane`、`resolveActivityPaneMode`、`updateQueueDisplay`、终端进度。
- **对话框 / 选择器**：帮助、会话选择器、记忆选择器、编辑器/模型/思考/主题/权限/设置选择器、审批/问题面板。
- **斜杠命令处理器**：`handleThemeCommand`、`handleModelCommand`、`handlePlanCommand`、`handleCompactCommand`、`handleLoginCommand` 等。

如果某个章节持续膨胀，请将纯函数、状态投影、展示组件和处理逻辑拆分到对应目录中，而不是继续扩展 `LmcodeTUI`。

---

## 新功能应该放哪 (apps/lmcode)

功能类型决定了它该放到哪里：

- **新 CLI 参数**：修改 `src/cli/commands.ts` / `src/cli/options.ts`，然后通过 `src/cli/run-shell.ts` 传入 TUI。不要让 CLI 直接操作会话。
- **新 CLI 子命令**：放在 `src/cli/sub/` 下，仅包含非交互式命令逻辑；需要 SDK 访问时，通过 `@lmcode-cli/lmcode-sdk` 实现。
- **新斜杠命令**：先在 `src/tui/commands/` 下修改定义、解析和类型；将执行入口放入 `LmcodeTUI` 的斜杠命令处理器章节；当复杂执行逻辑没有理由留在 `LmcodeTUI` 时，拆分到 `utils` 或专用组件中。
- **新技能衍生命令**：接入 `buildSkillSlashCommands` / 技能命令映射——不要硬编码单个技能。
- **新转录本消息类型**：在 `src/tui/types.ts` 中定义数据形状，在 `components/messages/` 下添加或扩展组件，并在 `createTranscriptComponent` 中注册渲染器。
- **新工具结果展示**：优先扩展 `components/messages/tool-renderers/registry.ts` 及对应的渲染器；不要在 `ToolCallComponent` 内部堆叠分支。
- **新弹窗 / 选择器**：放在 `components/dialogs/` 下，通过 `mountEditorReplacement` 挂载；如果触发来自 SDK 回调，还需检查 `reverse-rpc/` 是否需要适配器/控制器/处理器。
- **新 SDK 事件处理**：在 `handleEvent` 中添加分发，然后添加对应的 `handleXxx`。如果事件仅映射到一条转录本条目，则只需简单处理。
- **新会话启动 / 恢复行为**：放在会话管理章节中，保持 `init` 仅专注于启动编排。新的恢复重放行为属于 `Session Replay` 章节，并应尽可能复用实时渲染路径。
- **新状态栏、活动区域或队列显示**：修改 `chrome/footer`、`panes/activity`、`panes/queue` 及对应的 `updateXxx` 方法。
- **新配置选项**：先在 `src/tui/config.ts` 中修改读写逻辑和 schema，然后接入设置 UI；需要持久化时，通过 `saveTuiConfig` 处理。
- **新常量**：CLI/TUI 共享的非复制常量放在 `src/constant/` 中；仅在 TUI 内部复用的非复制常量放在 `src/tui/constant/` 中。组件局部的文案、选项标签、帮助描述、对话框标题/页脚文本——放在对应组件或命令旁边，不要集中到全局常量模块中。
- **新通用能力**：如果不依赖 TUI 状态，放在 `src/utils/` 下；如果依赖 TUI 状态或组件，放在 `src/tui/utils/` 下。

---

## TUI 编码规范 (apps/lmcode)

- 不要过度封装，尤其对于一两行的函数——不要引入两层包装，直接内联即可。
- 没有状态/UI 副作用的函数不应作为 `LmcodeTUI` 类的私有方法，应放在外部工具函数中。
- 常量必须放在对应的 `constant` 目录中，不能散落在组件或逻辑代码中。
- 在 `handleInput(data)` 中，当比较可打印字符（字母、数字、空格、标点）时，**禁止**编写诸如 `data === 'q'` 的字面量比较。在启用了 Kitty 键盘协议的终端（如 VSCode）中，这些键会以 CSI-u 序列发送（例如 `\x1b[113u`），裸比较永远不会匹配。先用 `src/tui/utils/printable-key.ts` 中的 `printableChar(data)` 解码，然后再比较；功能键继续使用 `matchesKey(data, Key.*)`；控制字符（码点 < 32）仍可与原始 `data` 比较。`test/tui/printable-key-guard.test.ts` 在 CI 中强制执行此规则。

---

## 如何设置主题 (apps/lmcode)

主题在 `src/tui/theme/` 下集中管理：

- `colors.ts` 定义语义令牌：`ColorPalette`、`darkColors`、`lightColors`。
- `styles.ts` 在 `ColorPalette` 之上构建通用的 chalk 帮助器。
- `pi-tui-theme.ts` 生成 pi-tui 所需的主题配置 markdown。
- `bundle.ts` 将 `colors`、`styles` 和 `markdownTheme` 打包为 `LmcodeTUIThemeBundle`。
- `index.ts` / `detect.ts` 处理主题类型及自动/暗色/亮色模式解析。

设置或切换主题时：

- UI 入口通过 `ThemeSelectorComponent`、`handleThemeCommand` 和 `applyThemeChoice` 实现。
- 真正应用步骤通过 `LmcodeTUI.applyTheme`，它应更新 `state.theme`、`state.appState.theme`，并通知相关组件刷新它们的调色板。
- 持久化用户选择通过 `saveTuiConfig` 处理。不要让组件自己写配置文件。

编写颜色时：

- 不要直接使用 chalk 命名颜色，如 `chalk.red`、`chalk.cyan`、`chalk.white`、`chalk.gray`、`chalk.dim` 或 `chalk.yellow`。
- 如果组件已有 `colors`，使用 `chalk.hex(colors.<token>)(text)`。
- 如果组件已有 `state.theme.styles` 或传入了 styles，优先使用 `styles.error(text)`、`styles.dim(text)` 等帮助器。
- 当新的视觉语义没有对应令牌时，先在 `ColorPalette` 中添加语义字段，并为 `darkColors` 和 `lightColors` 都填上值。
- 在亮色主题下，白色背景上的文字令牌对比度必须至少 4.5:1；边框和大面积 chrome 至少 3:1。
- 不要在模块顶层缓存带样式的 chalk 函数。主题切换必须在一次渲染内生效，因此样式必须在渲染路径上根据当前调色板生成。

主题变更后，非注释代码不得包含 chalk 命名颜色，如 `chalk.white`、`chalk.cyan`、`chalk.red`、`chalk.green`、`chalk.gray`、`chalk.yellow`、`chalk.blue`、`chalk.magenta`、`chalk.whiteBright` 或 `chalk.blackBright`。

---

## MCP (apps/lmcode)

ScreamCode 内置了 MCP 客户端。Agent 可以通过模型上下文协议（Model Context Protocol）调用外部工具（浏览器自动化、GitHub 操作、文件系统访问等）。

### 架构

```
/mcp panel → 写入 mcp.json → McpConnectionManager → StdioClient/HttpClient
                 ↑                                          ↓
           ~/.lmcode/mcp.json                   MCP 服务器进程
                                                      (通过 npx 启动)
```

- **配置**：`~/.lmcode/mcp.json`（用户全局）和 `<cwd>/.lmcode/mcp.json`（项目局部）。项目条目会覆盖同 key 的用户条目。
- **连接管理器**：`packages/agent-core/src/mcp/connection-manager.ts` —— `addServer`（运行时添加 + 连接）、`stopServer`（断开，保留条目）、`removeServer`（断开 + 删除条目）、`reconnect`（重连已有条目）。
- **RPC 链路**：`core-api.ts` → `core-impl.ts` → `session/rpc.ts` → node-sdk → TUI。
- **TUI 面板**：`apps/lmcode/src/tui/commands/mcp.ts` —— `/mcp` 斜杠命令，使用自定义的 `McpPickerComponent`。
- **页脚**：MCP 状态**不**显示在页脚状态栏中。使用 `/mcp` 查看。

### /mcp 面板

```
/mcp → MCP 管理面板
  ├─ 已安装的服务器（状态 + 工具数量）
  ├─ 回车 → 安装+启动（推荐）/ 切换启用/禁用（已安装）
  ├─ d → 卸载（从 mcp.json 移除 + 断开连接）
  └─ 内置推荐：Playwright（浏览器自动化）
```

### 添加推荐

编辑 `apps/lmcode/src/tui/commands/mcp.ts` 中的 `RECOMMENDED` 数组。

### 超时设置

- Playwright 推荐：`startupTimeoutMs: 300_000`（5 分钟——首次启动会下载 Chromium）。
- 全局默认：`DEFAULT_STARTUP_TIMEOUT_MS = 60_000`。

---

## 斜杠命令 (apps/lmcode)

所有斜杠命令在 `src/tui/commands/registry.ts` 中声明，在 `src/tui/commands/dispatch.ts` 中分发。除了在 `LmcodeTUI` 中记录的会话配置建模辅助工具外，这些命令还承载了重要的状态或后端集成：

### 狼群模式（`/wolfpack`）

批量并行子 agent 编排。切换 `AppState` 中的 `wolfpackMode`。激活时，LLM 可以使用 `WolfPack` 工具通过模板+条目模式（最多 20 个条目）生成并行子 agent，通过 `Promise.allSettled` 并发执行并汇总结果。端到端遵循 PlanMode 模式。

- **入口**：`/wolfpack`（别名：`wp`），无参数开关
- **状态机**：`packages/agent-core/src/agent/wolfpack/index.ts` —— `WolfPackMode`（enter / exit / restoreEnter / isActive）
- **注入器**：`packages/agent-core/src/agent/injection/wolfpack.ts` —— `WolfPackModeInjector`，在进入/退出时注入使用说明
- **工具**：`packages/agent-core/src/tools/builtin/collaboration/wolfpack.ts` —— `WolfPackTool`，运行时由 `wolfpackMode.isActive` 控制
- **权限策略**：`packages/agent-core/src/agent/permission/policies/wolfpack-mode-approve.ts` —— WolfPack 激活时自动批准所有工具
- **记录**：`wolfpack.enter` / `wolfpack.exit` 用于会话重放恢复
- **页脚徽章**：激活时以品牌蓝色显示 `wolfpack`

### 目标系统（`/goal`、`/goaloff`）

持久化目标注入，跨轮次和会话恢复保持有效。

- **TUI**：`src/tui/commands/goal.ts` —— 子命令：`status`、`pause`、`resume`、`replace`。`/goaloff` 完全取消。
- **状态**：`AppState.goal`、`goalActive`、`goalContinuationCount`。由 `GoalInjectionProvider` 注入到系统提示词中。
- **存储**：持久化到会话元数据（`custom.goal`）中，因此目标能在会话切换和恢复后继续存在。
- **页脚徽章**：激活时显示 🎯 + 截断的目标文本（绿色）。

#### 目标循环与 WriteGoalNote

目标系统以自主循环方式运行（`packages/agent-core/src/agent/turn/index.ts` 中的 `driveGoal()`）。每轮结束后，如果目标仍处于激活状态，会提示 agent 继续。执行过程中：

- **WriteGoalNote 工具**：`packages/agent-core/src/tools/builtin/goal/write-goal-note.ts` —— 让模型记录工作笔记（最多 10 条 × 200 字符）。笔记存储在 `GoalMode` 内存状态中，而非对话上下文中，因此压缩不会丢失它们。
- **GoalInjector**：`packages/agent-core/src/agent/injection/goal.ts` —— 在每次继续轮次的 `## Working Notes` 下注入笔记。同时提示模型在发现事实或遇到死胡同时使用 WriteGoalNote。
- **生命周期**：目标完成或取消时清除笔记。笔记在会话恢复后不会保留（模型会重新积累）。
- **TUI 排序**：`/goal` 在快速命令列表中排第 5（优先级 121，在 sessions 之后）。

### cc-connect（`/cc`）

一键 cc-connect 守护进程生命周期管理（跨平台）。

- **TUI**：`src/tui/commands/cc.ts` —— 带启动/停止/重启的面板。
- **平台**：macOS 使用 `launchd`、Linux 使用 `systemd`、Windows 使用 `pm2`。
- **页脚圆点**：cc-connect 激活时显示 `●` 绿色，否则变暗。每 3 秒通过 `refreshCcStatus()` 刷新。
- **配置**：`src/tui/commands/cc-connect.ts` —— 频道设置向导。

### 更新（`/update`）

从 GitHub 手动更新。启动时进行静默后台版本检查。

- **版本源**：`src/cli/update/cdn.ts` —— 获取 `api.github.com/repos/Lyin01/LMcode-cli/releases/latest`，去掉 `tag_name` 的 `v` 前缀。
- **缓存**：`src/cli/update/cache.ts` —— 读写 `~/.lmcode/updates/latest.json`。
- **比较**：`src/cli/update/select.ts` —— `semver.gt(latest, current)`。
- **TUI 启动**：`lmcode-tui.ts` 中的 `checkForUpdates()` 依次调用 `refreshUpdateCache()`、`readUpdateCache()` 和 `selectUpdateTarget()`。
- **欢迎面板**：当 `hasNewVersion` 为 true 时显示"有新版本（x.y.z）"。
- **手动触发**：`src/cli/update/` 中的 `/update` 命令 —— git pull → pnpm install → pnpm -r build，每一步都有超时和网络错误检测。
- **常量**：`src/constant/app.ts` —— `LMCODE_CDN_LATEST_URL`、`LMCODE_GITHUB_REPO`。

### /revoke

撤销最近 N 轮对话。锚定在用户消息上，如果所有消息都被移除则恢复欢迎面板。

- **TUI**：`src/tui/commands/revoke.ts` —— `findUndoAnchorEntryIndex`、`removeUndoContextComponents`。
- **Core**：`packages/agent-core/src/agent/context/index.ts` —— `undo()` 执行反向遍历，拼接消息，并向下钳制 `_tokenCount`。
- **可用性**：`idle-only`（仅空闲时可用）。

---

## Agent-Core 机制

### 压缩管道（Compaction Pipeline）

ScreamCode 拥有三级压缩管道，在 `packages/agent-core/src/agent/turn/index.ts` 的 `beforeStep` 钩子中协调。每一步在 LLM 调用之前执行：

```
阶段 1：微压缩（零 LLM）→ 将旧的工具结果截断为占位符，始终启用，在 >= 50% 使用率时触发
阶段 2：完整压缩（一次 LLM）→ LLM 总结旧消息，在 >= 75% 使用率时触发
阶段 3：阻塞压缩（安全网）→ 阻塞当前轮次直到压缩完成，在 >= 85% 使用率时触发
```

- **预测性触发**：预估下一步的 token 增长，在溢出之前主动压缩，而不是等待溢出发生。
- **断路器**：连续 3 次压缩失败 → 在当前轮次禁用自动压缩，下轮自动重置。
- **超时**：`block()` 最多等待 60 秒进行压缩，超时时取消并通知用户。
- **溢出快速失败**：当 API 返回上下文溢出错误时，`chatWithRetry` 不再重试 3 次——它立即暴露错误，以便上层触发紧急压缩。

关键文件：`packages/agent-core/src/agent/compaction/{micro,full,strategy}.ts`、
`packages/agent-core/src/loop/retry.ts`。

### 记忆系统（Memory System）

Agent 拥有由 `@lmcode-cli/memory` 包提供的记忆系统。定位为"任务经验记录"——结构化记录尝试了什么、什么有效、什么失败了。每条记录还携带 3-5 个语义 `tags` 和 `projectDir`。没有 `projectDir` 或 `tags` 的旧条目仍然可见可用。

- **存储**：SQLite 数据库位于 `<lmcodeHomeDir>/memory/memos.sqlite`（旧版 JSONL 位于 `<lmcodeHomeDir>/memory/entries.jsonl`，已迁移并保留为 `.bak`）。Schema 包含 `project_dir` 和 `tags`。
- **字段**：`userNeed`（需求）、`approach`（方案）、`outcome`（结果）、`whatFailed`（踩坑）、`whatWorked`（经验）、`projectDir`（项目目录）、`tags`（语义标签）。
- **提取触发器**：
  - 压缩：`packages/agent-core/src/agent/compaction/full.ts` 中的 `extractAndStoreMemos()` —— 扫描压缩摘要中的 `memory-memo` 块。
  - 会话退出：`packages/agent-core/src/agent/index.ts` 中的 `extractMemoriesOnExit()` —— 取最近 30 条消息 × 300 字符，调用 LLM。
  - 空闲定时器：用户无输入 10 分钟后，`LmcodeTUI.performIdleMemoryExtraction()` 调用 `session.extractMemoriesOnExit()`。冷却时间：10 分钟。压缩提取会更新冷却时间戳以避免重复。
  - 手动写入：`packages/agent-core/src/tools/builtin/memory/memory-write.ts` 中的 `MemoryWrite` 工具——当用户明确要求时，模型可以立即保存结构化备忘录，例如"保存到记忆"、"保存到备忘录"或"总结并保存"。这些条目被标记为 `extractionSource: 'manual'`。
- **评分**：关键词 Jaccard 相似度（45%）+ 90 天衰减（25%）+ 使用提升（15%）+ 项目亲和度（10%）+ 与当前项目标签云的标签重叠（5%）。纯规则实现，零 LLM 开销。

#### 主动查询

模型通过 `MemoryLookup` 工具按需查询记忆存储。不再在每轮开始时自动注入。

- **何时调用**：当前任务类似于之前的工作、遇到重复错误或模式、不确定最佳方案、或用户引用之前的修复/决策。
- **输入**：`query`（必填），可选 `limit`（默认 5，最大 20），可选 `min_score`（默认 0.2），可选 `scope`（默认 `'global'`；使用 `'project'` 将结果限制在当前工作目录）。
- **输出**：按相关性排序的备忘录，包含 `approach`、`outcome`、`whatFailed`、`whatWorked`、相关性 `score`、`projectDir` 和 `tags`。来自当前项目以及与当前项目共享标签的备忘录排名更高。模型应应用 `whatWorked` 并避免 `whatFailed`。
- **注册**：`ToolManager.initializeBuiltinTools()` 在 `memoStore` 可用时仅为 `main` agent 注册它。
- **手动注入**：用户仍可通过 `/memory` TUI 选择器（`apps/lmcode/src/tui/managers/dialog-manager.ts`）浏览和注入现有备忘录。

#### 编辑记忆

`MemoryEdit` 工具让模型通过 id 更正或删除单条备忘录。当用户说某条记忆错误、过时或应删除时使用。对于更新，只有提供的字段被更改；省略的字段被保留。`tags` 可以更新以添加或删除标签。

关键文件：`packages/agent-core/src/tools/builtin/memory/memory-lookup.ts`、
`packages/agent-core/src/tools/builtin/memory/memory-write.ts`、
`packages/agent-core/src/tools/builtin/memory/memory-edit.ts`、
`packages/memory/src/scoring.ts`、
`packages/memory/src/store.ts`。

#### 会话记忆

`SessionMemory` 跟踪当前会话中的每次工具执行（工具名称、参数摘要、成功/失败）。压缩后，一个摘要以 `<system-reminder>` 的形式注入，使模型即使在详细的对话历史被剥离后仍能感知最近的操作。

关键文件：`packages/agent-core/src/agent/session-memory.ts`。

#### 梦境合并（`/dream`）

一个 CCB 风格的四阶段记忆合并命令。LLM 驱动规划，程序化执行：

1. **定向（Orient）** —— `MemoryConsolidatePlan` 扫描所有记忆并报告概览统计（数量、结果分布、时间范围）。
2. **收集（Gather）** —— 模型审查程序化计划，语义检查误报、矛盾以及额外的过期条目。
3. **合并（Consolidate）** —— 模型向用户展示合并计划。
4. **修剪（Prune）** —— 用户确认后，`MemoryConsolidateApply` 删除原始条目，追加合并后的记录（带正确的 JSONL 信封），并重置 dream 跟踪器。

包含自动提醒：自上次 dream 以来 >= 24 小时且 >= 5 个会话时，在轮次的第一步注入一条建议。

`/dream` 全局操作，跨越所有项目的记忆。没有 `projectDir` 的旧条目仍被考虑，因此现有数据不会丢失。合并后的记录继承原始标签的并集。

- **跟踪器**：`packages/memory/src/dream.ts` —— `DreamTracker`，持久化到 `<lmcodeHomeDir>/dream-lock.json`（默认 `~/.lmcode/dream-lock.json`）。
- **存储**：`packages/memory/src/store.ts` —— `MemoryMemoStore`，持久化到 `<lmcodeHomeDir>/memory/entries.jsonl`。
- **合并器**：`packages/memory/src/consolidator.ts` —— `buildConsolidationPlan` / `applyConsolidation`。
- **工具**：`packages/agent-core/src/tools/builtin/memory/memory-consolidate.ts` —— `MemoryConsolidatePlan` / `MemoryConsolidateApply`。
- **技能**：`packages/agent-core/src/skill/builtin/dream.ts` + `dream.md`。

关键文件：`packages/memory/src/{dream,consolidator}.ts`、
`packages/agent-core/src/tools/builtin/memory/memory-consolidate.ts`、
`packages/agent-core/src/skill/builtin/dream.md`。

### LSP 集成（只读）

Agent 可以通过 `LSP` 工具查询语言服务器以获取只读的代码智能。这在重构、重命名或诊断类型错误之前非常有用。

- **操作**：
  - `references` —— 查找一个符号的所有用法。
  - `definition` —— 跳转到符号定义处。
  - `diagnostics` —— 获取文件的类型错误和警告。
- **输入**：`path`（必填）、`operation`（必填），references/definition 还需 `line`/`character`。`line` 从 1 开始，`character` 从 0 开始。
- **行为**：工具在语言服务器中打开文件，执行请求，并返回格式化的 markdown 列表。它不会修改文件。
- **支持的语言**：TypeScript/JavaScript（`typescript-language-server`）、Python（`pyright-langserver`）、Rust（`rust-analyzer`）、Go（`gopls`）。不支持的文件类型返回友好错误。
- **注册**：`ToolManager.initializeBuiltinTools()` 构建 `LspRegistry` 并为 main agent 注册 `LspTool`。

关键文件：`packages/agent-core/src/tools/builtin/lsp-tool.ts`、
`packages/agent-core/src/lsp/client.ts`、
`packages/agent-core/src/lsp/registry.ts`。

### WelcomeComponent 呼吸动画

欢迎标志以 40 毫秒间隔（25 fps）循环 24 色相色轮。

- **组件**：`src/tui/components/chrome/welcome.ts` —— `startBreathing()` / `stopBreathing()`。
- **生命周期**：呼吸动画在应用启动时自动开始。编辑器中的第一次按键触发 `onFirstInput`，永久调用 `stopBreathing()`。`firstInputFired` 在会话切换时永远不会重置。
- **会话切换**：`clearTranscriptAndRedraw()` **不会**调用 `resetFirstInputGate()`，因此呼吸动画保持关闭。`renderWelcome()` 在启动新组件之前检查 `hasFirstInputFired()`。
- **原因**：防止当转录本塞满了重放的历史组件时进行昂贵的全树重新渲染。

---

## 通用编码要求

- 对于可选对象属性，直接传递 `undefined` —— 不要使用条件展开。
- 可选对象属性不需要在类型中额外允许 `undefined`。
- 只有一个参数的内部方法不应为了风格统一而转为 options 对象。
- 除了包自身的 `index.ts` 外，其他 `index.ts` 文件应优先使用 `export * from './module'`。
