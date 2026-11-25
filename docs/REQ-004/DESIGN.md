# REQ-004 技术方案

认证返回额外内部 credentialKind/credentialId，凭据正文不持久化。MCP 每个请求重新认证；workerId 由连接器持久身份提供，所有服务仍在事务内检查凭据。OAuth 刷新保留 grant ID。

新增 assistant_workers 记录有界 worker 标识、显示名和 lastSeenAt；每次 poll 校验凭据并更新心跳。发现仅返回本人有权、未删除、已切换模式的非终态任务，活租约只对持有者可见。领取仍在独立事务决定胜者。

新增 assistant_poll/claim/work/heartbeat/acknowledge/report/read_scene/commit_edit/get_operation。控制与指令仍由成员网页的认证服务端接口发送。读回回执允许失去租约后的持有者确认历史结果，但不能产生新修改。业务错误返回 JSON error.code，未知错误不返回 SQL 参数。

工具注册独立于 HTTP 和全局数据库，使用真实 MCP handler 与隔离数据库验证认证工具交互。普通 edit_drawing 继续要求 Apply。
