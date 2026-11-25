# REQ-003 验证记录

目标验证通过，2026-11-25。

- `ASSISTANT_TEST_DATABASE_URL=… pnpm exec vitest run src/features/assistant src/features/collab/room-session.test.ts src/features/collab/scene-settings.test.ts --maxWorkers=2`：8 文件、163 项通过，包含 PostgreSQL 14 项。
- 7 项场景集成：无人在线持久化/幂等、无关人工编辑保留、目标冲突、暂停/新指令、凭据/租约/隔离、数据库失败无广播、设置字段级冲突。
- PostgreSQL：8 路并发提交只产生一回执，6 轮暂停与提交竞态验证锁顺序及迟到拒绝；实际执行迁移 0021。
- 103 项 Room 既有和新增回归通过，覆盖 shutdown、最终笔画、写入期间重连。
- `pnpm typecheck` 通过。

最终构建、格式及完整端到端联调归 REQ-010。实际队列回归错误已修正并记入 M004。

REQ-010 补充修复：后台新增元素在提交前生成合法 fractional index，使重新打开浏览器不会因补索引推进版本而误拒绝撤回。形状/标签索引、数据库与回执一致性新增回归通过；相关 4 文件 38 项通过，见 M007 和 REQ-010 最终证据。
