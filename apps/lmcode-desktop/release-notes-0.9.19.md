把 Claude 桌面端「输入 `/` 自动带出命令」的交互搬进 LMCODE Desktop，并顺手把命令表砍到只剩真正常用的那些。

### `/` 命令面板

输入框里只要消息以 `/` 开头，面板立刻弹出；继续打字实时过滤，排序是「精确匹配 > 命令名前缀 > 命令名包含 > 描述包含」。

- `↑` / `↓`：循环移动高亮
- `Tab`：补全为 `/goal `，光标停在参数位，不执行
- `Enter`：无参命令直接执行；`/goal` 这类需要参数的命令插入文本而不误跑
- `Esc`：关闭；同一个 token 继续打字才会重新弹出，不会立刻反弹
- 空格：进入参数区后面板自动收起，不抢目标文本
- 鼠标点击与 `Enter` 等价，且不把焦点从输入框抢走

实现位于 `apps/lmcode-desktop/src/renderer/lib/slash-command.ts`（触发判定、排序、补全、接受语义全部是纯函数，不依赖 React）与 `SlashCommandsDialog.tsx`（受控列表：分组标题、快捷键页脚、无匹配提示、选中项滚动跟随）。

### 技能并入同一个面板

会话内 `/` 面板现在同时列出内置命令和已安装技能（`listSkills`），技能单独分组并带「技能」标记，选中即走 `activateSkill`，不再需要切到扩展面板。本机实测 8 个命令 + 42 个技能。

### 欢迎页同样生效

首屏输入 `/` 也会弹出面板。选中命令后先按目标创建会话，再把命令交给新会话的 Composer 消费执行——`/help` 会在新会话里正常打出命令表，而不是被当成普通消息发给模型（`startSessionWithCommand` + `pendingComposerCommands`）。

### 删除低频命令

按「频次低且存在等价入口」的标准删掉 5 个，解析器、执行分支、`/help` 文本、面板目录一起收：

| 命令 | 删除理由 |
| --- | --- |
| `/dream` | 调 `activateSkill('dream')`，但本机没有该技能，点了必然失败的入口 |
| `/export` | 会话列表右键、设置面板、应用菜单三个入口已覆盖 |
| `/goaloff` | 与 `/goal off` 完全重复 |
| `/mode` | Composer 底部已有权限模式按钮 |
| `/config` | 侧栏底部已有「设置」入口 |

保留 8 个：`/goal` `/plan` `/review` `/model` `/compact` `/revoke` `/clear` `/help`。`/revoke`、`/compact` 在桌面端没有等价 UI 入口，删掉是净损失能力，故保留。

### 验证

- `test/slash-command.test.ts` 27 passed，全量 113 files / 705 tests passed
- `tsc --noEmit`（node / web / test）0 错误；`oxlint --type-aware --deny-warnings` 0 warning / 0 error
- CDP 驱动真实构建产物复测：面板 50 项（8 命令 + 42 技能）、`Tab` 补出 `/goal `、`/help` 打出命令表、无匹配提示、`Esc` 后编辑重开、欢迎页 8 项且 `/help` 在新会话执行
- 复跑脚本：`apps/lmcode-desktop/verify-slash-palette.mjs`
