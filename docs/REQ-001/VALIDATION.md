# REQ-001 验证记录

状态：已完成。验证日期：2026-11-25。

## 初始状态

- 基线分支：main；开始实施时工作区无未提交改动。
- 主机 Node.js：24.18.0；项目目标 Node.js：22。
- 主机开始时无 pnpm 和 Docker；已在 `/data/workspace/req001-tools` 安装隔离 Node 22.23.5、pnpm 11.14.0。
- 已安装 PostgreSQL 17.12，使用独立 `req001_test` 数据库及普通 user 所有者验证。没有使用应用 DATABASE_URL 或生产数据库。
- 锁文件安装完成，package.json 与 pnpm-lock.yaml 无依赖变更。

## 检查

| 检查 | 状态 | 证据 |
| --- | --- | --- |
| 基线检查 | 通过 | 原项目 typecheck、lint；173 个文件、1389 项测试通过，85.42 秒 |
| 领域契约测试 | 通过 | 4 项；终态、租约精确到期、Unicode/空消息/U+0000、分页 |
| PGlite 存储与迁移测试 | 通过 | 30 项；schema 6、conversations 8、runs 16 |
| PostgreSQL 并发与持久化测试 | 通过 | 10 项；PostgreSQL 17.12、连接池和独立应用进程 |
| 目标测试 | 通过 | `vitest run src/features/assistant --maxWorkers=2`，启用测试数据库后 5 个文件、44 项通过，5.91 秒 |
| 类型检查 | 通过 | `pnpm typecheck` |
| 国际化检查 | 通过 | `pnpm i18n:check`：590 条消息、六种语言，没有发现缺失翻译；unused-message 分析受动态导入等既有结构限制，工具返回成功 |
| Lint | 通过 | `pnpm lint`：573 个文件，无待修复项 |
| 全部测试 | 通过 | 启用独立 PostgreSQL 后，178 个文件、1433 项测试通过，87.41 秒 |
| 差异检查 | 通过 | `git diff --check`；新增迁移只增加 assistant 四表及其约束 |
| 迁移元数据一致性 | 通过 | 再次执行 `drizzle-kit generate --name=assistant_foundation_check`，返回 No schema changes，未生成额外迁移 |

## 实际执行方法

在仓库根目录，使用上述隔离工具路径：

```sh
export PATH="/data/workspace/req001-tools/node_modules/node/bin:/data/workspace/req001-tools/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile
DATABASE_URL='postgresql://user@localhost/req001_test?host=/var/run/postgresql' \
  pnpm exec drizzle-kit generate --name=assistant_foundation
ASSISTANT_TEST_DATABASE_URL='postgresql://user@localhost/req001_test?host=/var/run/postgresql' \
  pnpm exec vitest run src/features/assistant --maxWorkers=2
pnpm typecheck
pnpm i18n:check
pnpm lint
ASSISTANT_TEST_DATABASE_URL='postgresql://user@localhost/req001_test?host=/var/run/postgresql' \
  pnpm test --maxWorkers=2 --reporter=dot
git diff --check
```

沙箱检查时额外使用 `env -u NODE_OPTIONS` 避免主机注入浏览器启动脚本的噪声；不是应用运行要求。全量测试超过 60 秒，后台执行并读取完成日志；首次同步检查被工具超时打断不计作测试通过或断言失败。

临时原始日志：`/tmp/opencode/req001-baseline.log`、`/tmp/opencode/req001-final-tests.log`。完成结果已固定记录在本文，临时日志不作为唯一交付证据。

## 真实数据库验证内容

1. 八个连接并发打开会话、发送不同指令，只有一个会话和一个未结束任务，消息序号连续。
2. 同一指令并发重试只建立一条消息、推进一次控制版本。
3. 两个 worker 竞争领取只有一个成功，数据库中只有一条领取事件。
4. 完成回报并发重试只建立一条 AI 消息和一条完成回执。
5. 暂停与完成并发竞争，允许的结果为完成先提交，或者暂停先提交且旧完成被拒绝。
6. 补充指令与完成竞争，旧完成被拒绝或在旧任务结束后新建下一任务。
7. 人工触发事务写入失败，任务、消息、事件和计数器一起回滚；相同请求可重新提交。
8. 凭据删除和回报由锁排序；删除已提交后回报失败，不生成结果消息。
9. 新启动的 Node 应用进程连接同一数据库，读回相同任务终态、消息数和完成事件 ID。
10. 不经过服务层直接插入第二个未结束任务，被 PostgreSQL 唯一约束拒绝。

## 复核与已修正问题

- 迁移中的复合引用目标改为表内 UNIQUE，解决生成 SQL 的约束创建顺序。
- 生成的迁移 snapshot/journal 已按仓库 Biome 规范格式化。
- Vitest 与 typecheck 会生成同一个 Paraglide 目录，顺序运行；无关界面没有为临时生成错误作修改。
- 输入检查提前拒绝 U+0000，并限制 Unicode 消息长度。
- 服务层不导入数据库运行单例；worker 认证身份只接受可信调用层构造，服务内再次核验凭据归属和有效期。
- 处理失败测试和既有组件测试仍有预期的日志与 jsdom API 提示；没有失败断言。

## 交付边界

本需求为后续网页和 MCP 提供存储服务。完整 Codex 执行、自动改图、页面交互和场景撤回尚属后续需求。

未执行完整浏览器/Codex 端到端联调；尚无相关页面和 MCP 任务协议。未对真实模型进行调用。尚未实现自动取消/扫尾调度，租约过期通过当前时间校验和重新领取处理；完整生命周期通知由 REQ-008 交付。
