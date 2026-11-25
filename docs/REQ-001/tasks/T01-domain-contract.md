# T01：领域与接口契约

状态：已完成；依赖：无。

## 方案

在 `types.ts` 定义任务、控制、执行端身份、租约和分页类型；`schemas.ts` 定义运行时校验与字符、请求 ID、分页限制；`state.ts` 定义终态判断与带错误码的领域错误。

任务业务状态、用户期望控制、worker 已确认版本与连接有效期分别表示，避免把“暂停请求已保存”误认为“Codex 已停止”。租约代次与控制版本为独立屏障。

## 执行与验证

1. 定义命名与函数输入输出。
2. 对无效分页、空消息、Unicode 长度和状态判断写必要测试。
3. 冻结供 T02～T04 使用的契约，回填结果。

## 结果

已实现 types.ts、schemas.ts、state.ts。`pnpm exec vitest run src/features/assistant/state.test.ts`：4 个测试通过，覆盖终态、租约精确到期、Unicode 消息长度和分页校验。
