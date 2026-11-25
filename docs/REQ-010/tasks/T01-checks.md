# T01 最终检查

方案：全量 Vitest（含显式 PostgreSQL）、typecheck、i18n、lint、build 顺序核对生成输出与退出码。

验收：日志有最终退出状态；超时不视为通过；失败修复后跑受影响测试。

结果（2026-11-25）：已完成。联调修复后最终 189 个文件、1501 项测试全部通过，含 17 项真实 PostgreSQL 测试；typecheck、639 消息键六语言检查、610 文件 lint 和应用生产构建全部退出 0。顺序检查日志位于 `/tmp/opencode/req010-{tests,typecheck,build}.log`，对应 `.exit` 均为 0。迁移生成器识别 25 张表并报告无 schema 变化，drizzle-kit check 通过。最后将文件测试目录改为系统 tmpdir 后，相关 2 文件 3 项复验通过。
