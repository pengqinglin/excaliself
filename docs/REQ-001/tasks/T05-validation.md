# T05：验证、修正与交付记录

状态：已完成；依赖：T01～T04。

## 方案

沿用 Vitest、PGlite；新增可由环境变量显式启用的 PostgreSQL 测试，使用临时独立数据库。验证环境不复用生产 DATABASE_URL。运行目标测试后执行项目要求的检查，修正新引入问题并记录基线问题。

## 执行与验证

1. 验证真实迁移、权限、去重、状态、租约和并发。
2. 使用独立连接/进程验证记录在重连与重启后仍可读取。
3. 执行 typecheck、i18n:check、lint、test。
4. 检查 git diff、迁移 SQL、文档与实现一致性。
5. 更新 TODO、VALIDATION、全局进度与维护说明；实际错误追加到 MISTAKES。

## 结果

44 项目标测试通过，包含 PostgreSQL 17 的 10 项真实事务验证和独立应用进程读取。全量回归 178 个文件、1433 项测试通过；typecheck、i18n:check、lint、git diff --check 通过。迁移、实现、方案与边界已复核；三项实际问题记录在 MISTAKES。详细命令、验证内容和限制见 ../VALIDATION.md。
