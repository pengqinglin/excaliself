# REQ-007 验证记录

目标验证通过，2026-11-25。

- `ASSISTANT_TEST_DATABASE_URL=… pnpm exec vitest run src/features/assistant/revert.pglite.test.ts src/features/assistant/postgres.test.ts src/features/collab/scene-store.test.ts src/routes/_app/-components/AssistantPanel.test.tsx --maxWorkers=2`：4 文件 39 项通过。
- PGlite：添加/修改/删除和设置逆向、版本递增、无关人工编辑保留、目标冲突、重复撤回、原子暂停、其他成员/超期/图片丢失拒绝、失败完整回滚且不广播。
- 实际 SQL 图片清理：30 天期内 before 图片保留，超期可清理；恢复图片成功。
- PostgreSQL：8 路并发撤回只产生一笔逆向记录；旧 worker 提交被控制版本拦截；0023 实际迁移成功。
- React：回执 ID 调用、冲突提示和不虚报成功；六语言撤回文案齐全。类型检查通过；最终 i18n 与格式检查随 REQ-009/010 执行。
