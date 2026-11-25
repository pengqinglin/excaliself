# REQ-009 验证记录

目标验证通过，2026-11-25。

- 六语言 639 个消息键检查通过；新的面板/撤回/设置文案全部通过 m.*()，相对时间与计数按 locale。
- landing 独立锁文件安装：`pnpm install --ignore-workspace --frozen-lockfile`；`pnpm --ignore-workspace run build` 成功，30 页面，包含 /docs/ai-assistant/ 和导航检查。
- CLI `pnpm assistant:codex --help` 成功；systemd 和环境模板已提供。指南明确独立连接器/应用进程、Codex 登录、私有历史与画布权限、可靠回执、撤回和恢复。
- 已更新中英文 README、MCP/备份指南、CONTEXT、ADR 0004、协议文档、维护及各子任务执行结果。
- `pnpm typecheck`、`pnpm lint`、`git diff --check` 通过；生成 snapshot 仅格式化，语义未改变。
- 本机 `codex login status` 为 Not logged in。REQ-010 继续验证真实 HTTP/浏览器/子进程完整链路，真实远端模型调用将如实列明限制。
