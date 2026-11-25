# REQ-006 验证记录

目标验证通过，2026-11-25。

- `pnpm exec vitest run src/routes/_app/-components/AssistantPanel.test.tsx src/features/assistant/conversations.pglite.test.ts src/features/drawings/use-drawing-writer.test.tsx --maxWorkers=2`：3 文件 18 项通过。
- 5 项 React 行为：发送等待 prepare、失败保留草稿及请求 ID、最新版本控制与关闭不取消、纯文本与完成/保存区分、回执和更早历史加载。
- 数据库新增历史倒序游标测试，验证新消息到来时分页连续与跨成员拒绝。
- `pnpm typecheck`、`pnpm i18n:check` 通过，六语言齐全；国际化检查器对已有动态导入提示 unused-message incomplete，不影响翻译检查。
- 最终真实浏览器、窄屏与构建联调归 REQ-010。
