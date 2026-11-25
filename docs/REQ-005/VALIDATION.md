# REQ-005 验证记录

目标验证通过，2026-11-25。

- 连接器 3 文件 8 项：真实 MCP handler + PGlite 无浏览器改图、暂停停止后确认、恢复、新消息中断、未知最终响应重报、初次离线重试及凭据撤销中断。
- 真实 Node 子进程验证 JSONL 最终输出、thread ID、resume 参数、令牌不进 argv、reasoning 不进对话、信号停止并等待退出。
- 状态文件验证 0600/0700、原子串行更新、重启同身份及 pending 回报恢复、进程锁和 endpoint 隔离。
- `pnpm exec vitest run src/features/assistant/connector src/features/assistant/mcp.pglite.test.ts src/features/assistant/scene.pglite.test.ts --maxWorkers=2`：5 文件 18 项通过；`pnpm typecheck` 通过。
- `pnpm assistant:codex --help` 成功；本机 Codex CLI 0.160.0 的 exec/resume 参数解析核对通过。

以上进程和模型执行器测试不调用真实模型。最终联调将单独记录真实模型调用是否可用，不将模拟执行视为模型实测。连接器无需应用配置模型 API；使用本机 Codex 登录。
