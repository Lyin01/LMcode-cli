# LMCODE Desktop 上线安全门禁

## 环境边界（最高优先级）

| 资源 | 开发环境 | 生产环境 |
| --- | --- | --- |
| 运行判定 | 未打包 Electron | 已打包应用 |
| 用户数据 | Electron 默认目录加 `-development` 后缀 | Electron 默认 `userData` |
| 配置与密钥 | 开发 `userData/config.toml` | 生产 `userData/config.toml` |
| 会话、SQLite、记忆、日志 | 开发 `userData` | 生产 `userData` |
| 渲染页面 | 仅允许回环 HTTP 开发服务器或本地文件 | 仅允许打包的本地文件 |
| DevTools / 调试开关 | 仅专用开发启动器开启 | 强制关闭 |

不得通过 `LMCODE_HOME`、复制配置路径或共享数据库来绕过这个边界。若今后增加业务 API、认证、支付或云存储，也必须分别配置开发和生产域名、账户、数据库及密钥。

## 发布前必过项

正式发布只能通过 `pnpm run release` 或 `scripts/release.ps1`。门禁会依次执行：

1. Monorepo 源码密钥扫描；
2. 生产依赖漏洞审计；
3. Monorepo 类型检查、Lint 与工作区一致性检查；
4. Monorepo 全量测试、评测框架测试与无密钥 smoke；
5. Monorepo 全量构建。

任一步失败都不得上传。PowerShell 发布脚本只会在门禁全部通过后读取临时 `GH_TOKEN`，发布完成后立即清除该环境变量。

正式发布还会强制 Electron Builder 完成 Windows 代码签名。签名证书只能来自系统证书库或 CI/本机的安全环境变量；禁止把证书、证书密码或编码后的证书写入仓库。缺少有效证书时发布必须失败。

## 攻击者视角复核

- 渲染器必须保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- 生产 CSP 不允许网络连接、内联脚本、对象、表单或 iframe；外部导航仅允许 HTTPS 并交给系统浏览器。
- IPC 必须同时校验 `WebContents` 与受信渲染地址，不得新增通用命令执行桥。
- 配置 IPC 不得把 API Key、OAuth 引用、认证请求头或原始 TOML 返回给渲染器。
- 关键操作日志只能记录固定事件名与非敏感状态，禁止记录提示词、终端输入、密钥、请求头、文件内容或完整配置。
- 附件入口必须拒绝环境文件、私钥、Cookie、凭据目录以及当前运行环境的配置密钥文件。

## 当前不适用项

当前产品是固定 Chromium 运行时的 Electron 桌面应用，没有登录、支付、业务后端或服务端媒体库。因此多浏览器矩阵与 OSS 迁移目前不适用；一旦新增对应能力，本清单必须先更新再实现。所有动画必须继续支持 `prefers-reduced-motion`。
