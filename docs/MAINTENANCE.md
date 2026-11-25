# 开发与维护记录

最后更新：2026-11-25

## 文档导航

- [全局规划](PROJECT-PLAN.md)：需求顺序与范围。
- [总进度](PROJECT-PROGRESS.md)：当前任务与完成证据。
- `REQ-NNN/README.md`：需求范围；`DESIGN.md`：方案；`TODO.md`：待办；`VALIDATION.md`：验证结果。
- [历史犯错](MISTAKES.md)：实际错误及防复发措施。

需求管理文档按本次用户要求放在 `docs/`；本次不使用原有 `.scratch/` 任务约定。

## 开发环境

项目 CI 与 Dockerfile 使用 Node.js 22、pnpm 11.14.0。安装依赖使用 `pnpm install --frozen-lockfile`，保留现有锁文件。临时工具和验证数据库放在工作区工具目录或 `/tmp/opencode`，不提交密钥与环境文件。

本地免 PostgreSQL 体验：`pnpm dev:preview`，访问 `/preview/login`。预览模式使用内存 PGlite，进程重启丢失数据；不能据此宣称持久化重启恢复已验证。

## 常规检查

```sh
pnpm typecheck
pnpm i18n:check
pnpm lint
pnpm test
```

变更数据库结构后执行 `pnpm db:generate` 并检查迁移 SQL、snapshot 和 journal。生成迁移只需要连接配置；实际迁移和并发行为另行验证。

## 数据与部署

- 正式数据存于 PostgreSQL；应用启动自动执行 `drizzle/` 迁移。
- 迁移前备份数据库。任何回滚先评估新表中的数据，不能通过删除已应用迁移回滚生产数据。
- Room 和列表通知在应用进程内存，现有部署应为单应用进程。
- 开发者文档与已发布用户文档分开；用户文档位于 `landing/src/content/docs/`。

## AI 功能维护边界

REQ-001～008 的实现包含私有会话、任务、服务端画布交接、后台可靠提交、MCP 工具、Codex 常驻连接器、网页控制、撤回和生命周期。最终完整构建/端到端证据汇总于 REQ-010。

- 服务入口：`src/features/assistant/{store,scene,revert,workers,lifecycle}.ts`；成员接口 `server.ts`；MCP 注册 `mcp.ts`。
- 画布模式 `drawings.serverManagedAt` 单向启用，`sceneRevision` 为持久化版本；模式不改变 Private/Team 权限。
- 每条 AI 保存的证明是 assistant_operations 回执；completed 自然语言回复与场景保存分别记录。
- Room 的 serial 队列协调元素、设置、flush 和严格命令；仍只运行一个应用进程。
- 0019～0023 迁移必须随源码部署并保留 journal/snapshot；新表跟随绘图/账号外键清理。
- 运维配置与 systemd 示例见 `landing/src/content/docs/ai-assistant.md`、`docs/examples/`；协议见 [assistant-protocol.md](assistant-protocol.md)。

## REQ-001 的测试与排障

- 存储服务入口：`src/features/assistant/store.ts`；成员服务端接口：`server.ts`；状态错误码和租约常量：`state.ts`。
- 当前租约 60 秒；执行端应独立续租，续租不会标记消息已接收。
- PostgreSQL 测试只读取显式 `ASSISTANT_TEST_DATABASE_URL`，要求数据库名以 `_test` 结尾；不设置时跳过 17 项真实数据库测试，普通 PGlite 测试仍运行。
- 测试库先执行正式迁移，数据使用随机 ID，并清理自身创建的用户和绘图；不要将该变量设为应用或生产数据库。
- `pnpm exec vitest run src/features/assistant --maxWorkers=2` 验证本模块。最终完整命令与结果见 [REQ-010/VALIDATION.md](REQ-010/VALIDATION.md)，REQ-001 记录仅代表该阶段的代码。
- 单活跃任务错误应检查任务是否已有 queued/running/awaiting_input 记录；不可直接删行解除租约。暂停通过 control 字段表达，仍占用当前任务。
- `lease_lost`：停止当前工作，读取状态或重新领取；`stale_control`：重读并确认最新消息；`credential_revoked`：停止使用该凭据。
- `completed` 表示执行端完成回报；查看 operationId 及 sceneRevision 对应的持久化回执确认实际修改。

## Codex 连接器

- 入口 `pnpm assistant:codex`；`--help` 查看配置，使用已有 Codex CLI 登录；参数解析核对版本为 0.160.0，真实模型运行需要连接器机器的 Codex 登录。
- `EXCALISELF_URL`、`EXCALISELF_TOKEN` 只配置在连接器进程。状态目录不存令牌，存有私人结果，保持 0700/0600。
- 每进程 workerId 带随机实例，优雅退出停止子进程；强杀后最多等旧 60 秒租约过期，不手改代次来复用活租约。
- 本地 pending report 持有原 workerId 和 requestId；先验证 memberId，再按原身份重报。换账号使用单独目录。
- 撤销凭据先提交删除再释放租约，避免 credential/run 锁反转；若进程恰在两步间退出，旧凭据仍已失效，租约自然过期后可重领。
- 回收站取消任务且恢复不重启旧任务；应用崩溃后的未 flush 人工编辑仍遵循既有 Room 限制，AI 回执只在事务成功后产生。
- 撤回期 30 天；清理图片要保留有效操作 before 引用。不要绕过 Room 队列直接更新场景。

本机使用隔离工具目录 `/data/workspace/req001-tools`，本地 PostgreSQL 17 的 `req001_test` 库。需要时可用 `pg_lsclusters` 检查状态、`sudo pg_ctlcluster 17 main start` 启动。普通角色无需 CREATEDB；由数据库管理员创建独立测试库并指定所有者。

Vitest、typecheck 与应用 build 应顺序执行，避免同时重新生成 `src/paraglide`。本机全量测试约 118～156 秒，终端超时需要适当设置或后台执行并检查最终退出结果。应用联调使用另建的 `req010_test` 库；系统 Chromium 和 Playwright 在隔离工具目录中，未添加浏览器测试工具为应用运行依赖。

后台提交用独立 `fractional-indexing` 生成新增元素的排序索引，避免浏览器首次打开时补索引推进版本而使撤回冲突（M007）。最终回报重放允许同成员替换凭据恢复已保存结果；新提交继续核验原租约（M006）。
