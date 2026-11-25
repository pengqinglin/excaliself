# T02：数据库结构与迁移

状态：已完成；依赖：T01。

## 方案

扩展现有 schema，增加 conversations、runs、messages、events 四张表。通过数据库 CHECK 约束有效状态、正序号、租约字段一致性；通过复合唯一键及外键保持消息、任务和会话归属一致。部分唯一索引保证同会话至多一个未结束任务。

执行 `pnpm db:generate` 生成迁移、snapshot 与 journal。已有绘图、提案和协作数据不转换。

## 执行与验证

1. 实现 schema 并生成迁移。
2. 检查 SQL 无意外删除或旧表改动。
3. 在迁移测试中验证空库和已有数据升级，验证唯一键、级联和非法字段拒绝。

## 结果

四表与 0019_assistant_foundation 迁移、snapshot、journal 已生成。PGlite 迁移、部分唯一键、内容约束、复合外键、级联和旧库升级 6 个测试通过。首次迁移顺序问题及修正记入 M002；真实 PostgreSQL 并发验证在 T05 完成。
