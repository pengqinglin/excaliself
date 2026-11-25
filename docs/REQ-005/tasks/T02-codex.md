# T02 Codex 执行

方案：通过 Codex CLI exec/resume JSONL 运行，持久 thread ID，限制可用任务工具，独立心跳并监听控制。已完成。

验收：暂停/新输入中断实际子进程；终端退出清理；恢复携带新版本及历史；不传播 reasoning 事件。

结果：真实子进程及模型执行器替身测试通过；CLI 0.160.0 参数解析核对，见 [验证](../VALIDATION.md)。
