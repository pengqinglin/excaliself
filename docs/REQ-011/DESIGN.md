# 本地连接与续画方案

复用已有 MCP 任务、租约、控制版本、保存回执和 Room 写入流程。Codex CLI 未登录不应阻止使用本机已配置模型的 OpenCode。

新增 `assistant:opencode`，常驻轮询领取任务，使用 `opencode --pure run --format json` 调用真实模型。按成员和端点隔离 journal，保存原生 session ID，后续任务用 `--session` 继续。执行端显示名由连接器上报，可包含明确选择的模型；状态仅代表连接器心跳，任务及保存回执说明执行结果。

新启动的 OpenCode 通过环境注入 MCP 配置及 Excaliself 令牌，继承其模型提供方配置；不把令牌放进 argv、journal 或用户界面。独立主 agent 只允许三个场景工具，其他任务控制仍由常驻连接器负责。中止、超时、等待实际退出、最终 JSON 校验和不确定回报恢复保持已有协议。

网页显示当前实例 `/api/mcp` 地址、Codex/OpenCode 启动命令和已连接执行端名称，通用状态文案不再把所有执行端称为 Codex。成功演示必须有真实场景读取、模型工具调用和持久化回执，并验证原图元素保留、后续指令在同一画布继续。
