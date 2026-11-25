# T02 MCP 工具

方案：独立注册九个任务工具，统一 Zod 输入和 JSON 业务错误；复用已有存储与场景命令。已完成，见需求验收记录。

验收：调用者不能传 userId/credentialId；保存响应含持久化 operation ID。
