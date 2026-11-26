# REQ-011 验证记录

2026-11-25 完成真实 OpenCode 两轮续画与自动检查；2026-11-26 完成提交前场景复核和独立画布 WebSocket 复验。本轮真实模型为 OpenCode 1.19.6 使用的 `xingchi/gpt-6.1-sol`，未使用模型替身。本机 Codex 0.160.0 仍未登录，其真实模型调用不属于本轮成功证据。

## 自动检查与构建

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 助手模块及面板 Vitest，`--maxWorkers=1` | 14 文件、98 项通过，28.07 秒；显式启用 17 项真实 PostgreSQL 测试 | `/tmp/opencode/req011-checks.log`、`req011-vitest.exit`（0） |
| `pnpm typecheck` | 通过；初次的 session ID 类型收窄错误修正后重跑成功 | `req011-typecheck.exit`（0） |
| `pnpm i18n:check` | 643 消息键、六语言通过 | `req011-i18n:check.exit`（0）；既有动态导入导致 unused-message 分析不完整 |
| `pnpm lint` | 614 文件通过 | `req011-lint.exit`（0） |
| `pnpm build` | 应用生产构建通过 | `req011-build.exit`（0） |
| landing `pnpm --ignore-workspace run build` | 30 页面构建通过 | 包含 `/docs/ai-assistant/` |
| 真实 WebSocket smoke | 11 项全部通过，独立空白测试绘图及分享在结束后清理 | `/tmp/opencode/req011-ws-smoke.log`、`req011-ws-smoke.exit`（0） |

执行环境为隔离 Node 22.23.5、pnpm 11.14.0、PostgreSQL 17.12。自动测试使用 `localqa_unit_20261125_test`，真实浏览器与生产服务使用另一个隔离库 `localqa_20261125_test`。Vitest、typecheck 和应用 build 顺序执行，避免争写 Paraglide 生成目录。

新增执行器测试启动真实 Node 子进程 fixture，验证 session 恢复、令牌不进 argv、三个工具的独立权限、等待中止的子进程实际退出、非法或错误结果拒绝。这些确定性测试与下述真实模型演示分别记录。

## 真实模型读取与连续续画

本地生产服务为 `http://127.0.0.1:3131`。演示绘图 `5f7526d4-4b2a-4632-972d-0fb588e5c5bf` 最初已有“浏览器 → API → 数据库”和标题、标签；实际连接器通过 HTTP MCP 领取网页指令并调用真实 OpenCode。

1. 第一轮读取当前场景，保留三个原节点 ID 和蓝色／绿色配色，插入浅黄色 Redis 缓存，右移数据库，删除 API→数据库直连，改为浏览器→API→Redis 缓存→数据库。任务 `14a8a76a-5f1b-441c-b56c-8d0b886a4ebf` completed，保存回执 `e644cc3c-e3d7-4b98-8577-0904be94538d`，sceneRevision 3，14 个未删除元素。
2. 第二轮沿用同一画布和原生会话，把 Redis→数据库标为“缓存未命中”，增加浅紫色“日志服务”及 API→日志服务的“异步日志”箭头。任务 `a23ee4cb-c32f-4c3e-9867-466cace32b14` completed，保存回执 `2ba28774-66e5-414b-835e-42620049b397`，sceneRevision 5，18 个未删除元素。

两轮使用同一会话 `7c8411ba-3f9d-447a-be7d-60f71e3c2705` 及原生 OpenCode session `ses_decb40db9ffeJhUh7vbKGa3nrZ`。独立验证原节点 ID、配色及四条连线和标签，确认旧直连不存在；2026-11-26 提交前复核再次通过。真实模型首次误将绑定标签作为独立元素修改，服务端返回 invalid_input；模型重新读取并修正后成功，拒绝的请求未部分保存。

证据为 `/tmp/opencode/opencode-demo-report.json`、`opencode-demo-live.log`、`opencode-demo-tools.json`、`opencode-demo.exit`（0）。工具证据来自真实 OpenCode session 导出，只记录工具输入与输出；演示报告和截图不含个人令牌。

## 网页与 WebSocket 复核

- 设置页和画布均显示 `OpenCode · xingchi/gpt-6.1-sol`，面板显示“AI 连接器在线”“任务已完成”，设置页给出本实例 MCP 地址及两种执行端的启动命令。
- 中文 390×844 窄屏中面板边界为 x=12、y=12、width=366、height=820，输入框及执行端名称可见，无横向溢出。桌面和窄屏复核脚本 `/tmp/opencode/opencode-demo-verify.mts` 成功。
- 截图：`/tmp/opencode/opencode-demo-settings.png`、`opencode-demo-final.png`、`opencode-demo-mobile.png`。机器桌面保留真实演示及运行中的连接器。
- 最初直接运行 smoke 误选了桌面打开的演示房间，人数、席位和最后离开落库共 4 项断言失败。改为创建专用空白测试绘图并显式传入其分享 token，同一生产服务的 11 项全部通过；没有以关闭断言的方式规避失败。演示场景随后独立复核正常，见 M008。

## 复验入口

在准备好名称以 `_test` 结尾的独立 PostgreSQL 库后运行：

```sh
export ASSISTANT_TEST_DATABASE_URL='postgresql://user@localhost/assistant_test?host=/var/run/postgresql'
pnpm exec vitest run src/features/assistant src/routes/_app/-components/AssistantPanel.test.tsx --maxWorkers=1
pnpm typecheck
pnpm i18n:check
pnpm lint
pnpm build
```

在单独终端按用户指南运行 `pnpm assistant:opencode`，由网页向已有画布发送第一轮与后续指令，并查看保存回执。WebSocket 复验必须选无人使用的专用测试绘图，不能在正在演示或编辑的房间运行。本机临时隔离脚本为 `/tmp/opencode/req011-isolated-ws.mjs`；它只连接上述 QA 库，创建并清理自己的绘图和分享。
