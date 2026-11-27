# REQ-012 验收记录

2026-11-26 完成本需求实现及端到端验收。真实模型验收使用 OpenCode 1.19.6 和 `xingchi/gpt-6.1-sol`，通过新建的绘图专用 MCP 邀请连接；没有在网页填写模型凭据。生产构建服务使用隔离 PostgreSQL 数据库，完整流程先经过真实 HTTP 与 Chromium 浏览器，再由真实模型完成续画。

## 自动检查和迁移

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 完整 Vitest（含隔离真实 PostgreSQL 并发测试） | 192 个测试文件、1520 项全部通过 | `/tmp/opencode/req012-test.result.json`，退出码 0 |
| `pnpm typecheck` | 通过 | `/tmp/opencode/req012-typecheck.result.json`，退出码 0 |
| `pnpm i18n:check` | 六语言通过 | `/tmp/opencode/req012-i18n.result.json`，退出码 0 |
| `pnpm lint` | 通过 | `/tmp/opencode/req012-lint.result.json`，退出码 0 |
| 应用 `pnpm build` | 生产构建通过 | `/tmp/opencode/req012-build.result.json`，退出码 0 |
| landing 文档站构建 | 生产构建通过 | `/tmp/opencode/req012-landing.result.json`，退出码 0 |
| 数据库迁移 | `0024_bright_harrier` 已应用到专用测试库 | `/tmp/opencode/req012-service.log` |
| WebSocket smoke | 11 项全部通过并清理隔离绘图 | `/tmp/opencode/req012-ws.log`、`req012-ws-result.json` |

Vitest、类型检查、Lint 与应用构建按顺序运行，避免争用 Paraglide 生成目录。测试与浏览器验证均使用隔离的 `_test` 数据库，不连接或改写用户生产数据。

## HTTP、邀请和浏览器交接

隔离生产构建入口为 `http://127.0.0.1:3132`，数据存储在 `req012_live_20261126_test`。脚本 `/tmp/opencode/req012-e2e.mts` 通过真实 Chromium 和 HTTP MCP 验证以下流程，完整日志为 `/tmp/opencode/req012-e2e.log`，结构化结果为 `/tmp/opencode/req012-e2e-report.json`：

- 浏览器完成管理员登录、新建已绘制内容的画布，打开邀请并一键复制；数据库只保存授权哈希，邀请只注册六个当前画布工具。
- 构造另一绘图 context 被拒；读取、直接保存、相同 requestId 重放及回执恢复成功，保留原人工内容。
- AI 工作时在网页点击“我来画”，迟到的读写请求被拒；真实鼠标绘图后立即“交给 AI”，同步 ACK 均标记 `saved`，第一轮重新读取已包含最后一笔，暂停前 context 无法继续提交。
- 邀请操作可通过现有撤回流程回滚，且保留无关人工元素；折叠面板仍能显示 AI 状态并接管。
- 轮换、过期、关闭访问立即拒绝已初始化 MCP 客户端的后续请求。完成的外部 AI 对话不会被按钮假称唤醒。
- 390×844 窄屏布局可画图并立即交回；中文窄屏控件可见，无未捕获浏览器错误。全部 8 个捕获到的 Room 同步 ACK 均确认保存。

截图：`/tmp/opencode/req012-desktop.png`、`req012-collapsed.png`、`req012-mobile.png`、`req012-chinese-mobile.png`。

## 真实 OpenCode 续画、接管和恢复

真实 MCP 客户端只被授权调用邀请提供的 `canvas_*` 工具。一次原生 OpenCode 会话在同一画布完成以下测试，完整脱敏日志为 `/tmp/opencode/req012-model.log`，证据摘要为 `/tmp/opencode/req012-model-report.json`：

1. 先读取已有画布，新增浅黄色“Redis 缓存”节点与箭头；服务返回 `saved` 操作回执，再读取确认内容和原有元素位置保留。
2. 第二轮真实模型已读取后，浏览器用户接管。模型随后的迟到提交返回 `stale_control`，没有产生新保存操作。
3. 用户以真实鼠标新增矩形并交回；同一个 OpenCode 会话再次读取最新场景，报告其中六个矩形及新增人工元素 ID，以全新 context/base 新增浅紫色“日志服务”节点和 Redis 箭头，收到 `saved` 回执并再次读取确认。

图片：`/tmp/opencode/req012-real-model-first.png`、`req012-real-model-resumed.png`。

## 图片、设置、重启和实时访问权

`/tmp/opencode/req012-persistence.log` 与 `req012-persistence-report.json` 记录真实浏览器和隔离数据库复验：

- 通过剪贴板实际粘贴 PNG，并人为延迟图片上传；在图片字节存库前 AI 仍保持暂停，恢复后首读包含图片且数据库字节长度大于零。
- 通过 Excalidraw UI 切换网格，交回后首读及数据库保存设置一致。
- 关闭并重启专用生产构建进程后，画布场景、图片、设置、授权和操作回执均保持，MCP 客户端可继续读取。
- 通过隔离数据库模拟当前访问权丢失及绘图回收站状态，既有 MCP 客户端的后续请求被拒；恢复测试数据后授权再次可用。

## 本地复验入口

复验前准备隔离且名称以 `_test` 结尾的 PostgreSQL 数据库，并按仓库规定配置 `ASSISTANT_TEST_DATABASE_URL`。本轮生产构建、浏览器、真实模型与持久化脚本位于 `/tmp/opencode/req012-*.mts`，测试私有密钥只由本地脚本使用，不属于仓库证据文件。完整自动检查顺序见 `/tmp/opencode/req012-checks.mjs`。当前服务只监听本机 `127.0.0.1:3132`。
