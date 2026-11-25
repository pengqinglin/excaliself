# REQ-010 最终验收记录

验收日期：2026-11-25。代码、构建和受控端到端验收通过；真实远端模型调用受本机 Codex 未登录限制。各需求的早期目标测试只代表当时阶段。

## 自动检查与构建

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| 全量 Vitest，`--maxWorkers=2` | 189 文件、1501 项全部通过，含 17 项真实 PostgreSQL 测试；117.99 秒 | `/tmp/opencode/req010-tests.log`，对应 `.exit` 为 0 |
| `pnpm typecheck` | 通过 | `/tmp/opencode/req010-typecheck.log`，对应 `.exit` 为 0 |
| `pnpm i18n:check` | 639 消息键、六语言检查通过 | 无翻译缺失；动态导入导致既有 unused-message 分析不完整提示 |
| `pnpm lint` | 610 文件通过 | Biome 无修复或错误 |
| `pnpm build` | 应用生产构建通过 | `/tmp/opencode/req010-build.log`，对应 `.exit` 为 0 |
| landing `pnpm --ignore-workspace run build` | 30 页面构建通过 | 含 `/docs/ai-assistant/` |
| `pnpm db:generate`、`pnpm exec drizzle-kit check` | 25 表，无 schema 差异，snapshot/journal 一致 | 显式连接隔离测试库 |
| `git diff --check`、`git diff --cached --check` | 通过 | 最终工作区和暂存区无空白差异错误 |

环境为隔离 Node 22.23.5、pnpm 11.14.0、PostgreSQL 17.12。Vitest、typecheck、应用 build 顺序执行。真实并发测试只读取 `ASSISTANT_TEST_DATABASE_URL`，本机为 `req001_test`；生产服务联调另用 `req010_test`，无应用或生产数据。

本轮发现并修复两项实际问题：同成员更换凭据后恢复已保存最终回复的幂等冲突（M006）；后台新增形状和标签的 null index 导致浏览器补索引使撤回误判冲突（M007）。先复现再修复，相关 4 文件 38 项通过，随后以上最终全量检查通过。最终审查还将连接器文件测试改用系统 `tmpdir()`，消除对本机 `/tmp/opencode` 目录的依赖；2 文件 3 项复验通过。

## 真实服务与浏览器

生产构建由 `node .output/server/index.mjs` 在本地 3130 端口运行，启动时实际执行 0019～0023 迁移；使用系统 Chromium 和隔离 Playwright。常驻连接器通过真实网络 `/api/mcp`，执行真实 JSONL 子进程，子进程用受控逻辑替代远端模型。

15 项完整流程全部通过，脚本退出 0，浏览器收到 31 个 WebSocket 帧且无未捕获异常：

1. 真实初始化管理员和登录会话。
2. 网页创建个人令牌，真实 HTTP MCP 认证成功，无凭据请求返回 401。
3. 已有人工矩形的私人绘图首次交接，人工场景保留。
4. 关闭最后绘图页面后连接器完成并保存回执；同请求重试返回同回执。
5. 重开绘图恢复历史，区分任务完成与场景已保存。
6. 重开后立即撤回成功，逆向回执持久化并保留人工矩形。
7. 暂停确认前停止实际子进程，旧控制版本的迟到 HTTP 提交被拒绝。
8. 继续及补充指令以新控制上下文执行并完成。
9. 第二个认证 WebSocket 客户端修改目标后，撤回原子拒绝且不追加回执。
10. 取消活跃任务后不再新增操作。
11. awaiting_input 问题与成员回复重新进入执行并完成。
12. 另一真实成员可见共享场景，但私人历史为空，原成员回执查询返回 not_found。
13. 390×844 窄屏从编辑菜单打开面板；边界 x=12、y=12、width=366、height=820，输入框可见且无溢出。
14. 停止并重启生产应用进程后，场景、消息、任务状态和回执完整回读，元素与重启前一致。
15. 全流程无浏览器未捕获异常，真实 WebSocket 更新可达。

证据：`/tmp/opencode/req010-e2e.log`、`req010-e2e-report.json`、`req010-e2e.exit`（0），桌面截图 `req010-desktop.png`、窄屏截图 `req010-mobile.png`；报告和截图未包含令牌。`req010-service.log` 与 `req010-service-restart.log` 记录两次生产启动和迁移检查。

在上述浏览器全部关闭后，使用同一隔离 PostgreSQL 和重启后的生产服务执行 `pnpm smoke:ws --url http://127.0.0.1:3130`，11 项全部通过：无效链接关闭码、心跳、帧上限、加入 ID、双端游标和离开、跟随视角、参与者数量上限、场景初始化、修改及晚加入同步、旧版本纠正、最后离开实际落库。该命令退出 0，临时分享自动清理。

## 复验入口

在已安装依赖的仓库中，指定自行创建且名称以 `_test` 结尾的数据库：

```sh
export ASSISTANT_TEST_DATABASE_URL='postgresql://user@localhost/req001_test?host=/var/run/postgresql'
pnpm exec vitest run --maxWorkers=2
pnpm typecheck
pnpm i18n:check
pnpm lint
pnpm build
```

随后以独立测试数据库启动一个生产应用进程，通过网页登录后运行 `DATABASE_URL=... pnpm smoke:ws --url http://127.0.0.1:3130`；该命令为测试绘图临时创建分享，须使用隔离数据库。浏览器验收脚本及无令牌报告位于本机 `/tmp/opencode/req010-e2e.mts`、`req010-e2e-report.json`，可在同一隔离环境复跑，不能用于真实应用库。连接器的可移植自动回归入口为 `pnpm exec vitest run src/features/assistant/connector --maxWorkers=2`。

## 真实模型环境限制

本机 Codex CLI 为 0.160.0，exec/resume/output-schema 参数解析已核对。`codex login status` 返回 `Not logged in`，因此未调用远端 Codex 模型。受控子进程覆盖任务协议、真实网络、持久化和中断，不能作为模型生成质量或真实登录后调用的证明。实际使用前在连接器机器执行 `codex login` 并运行常驻连接器；无需应用配置模型 API 密钥。
