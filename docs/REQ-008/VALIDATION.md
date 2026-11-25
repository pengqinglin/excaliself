# REQ-008 验证记录

目标验证通过，2026-11-25。

- `ASSISTANT_TEST_DATABASE_URL=… pnpm exec vitest run src/features/assistant/lifecycle.pglite.test.ts src/features/assistant/postgres.test.ts src/features/assistant/connector/integration.pglite.test.ts --maxWorkers=2`：3 文件 31 项通过。
- 生命周期 7 项：回收站/恢复新任务、文件夹多成员取消、取消失败原子回滚、个人令牌和 OAuth grant 撤销后立即重领、强杀实例租约隔离、删除账号清理会话/回执/worker 且保留 Team 场景。
- 连接器：跨实例 journal 用原 workerId 重放，执行实例各异，换成员时保留 journal 并拒绝错误账号使用。
- PostgreSQL 17 项总计通过，新增 6 轮撤销/提交竞争无锁反转、4 轮回收站/提交竞争有序取消。
- 先前 OAuth、回收站、面板及连接器回归 6 文件 27 项通过；`pnpm typecheck` 通过。

REQ-010 补充：新增同成员更换令牌后重放已提交最终回报的回归，先复现幂等冲突再修复。回报哈希绑定成员和原执行实例，当前凭据仍需有效；未提交的新回报继续要求原租约。恢复只清空 journal，不重复运行模型或追加回复，相关任务/连接器 24 项通过（M006）。
