# REQ-001 技术方案

## 分层

新增 `src/features/assistant/`。纯状态与输入契约、数据库服务、成员认证服务端函数分开。数据库服务接受已有 `Db`，可由 PGlite 和 PostgreSQL 测试直接调用；不导入运行中的数据库单例。认证来源由调用层提供，执行端身份必须由后续 MCP 认证层构造，不能直接采用网页参数。

## 数据模型

| 表 | 作用 | 约束 |
| --- | --- | --- |
| `assistant_conversations` | 成员＋绘图会话，消息与事件序号计数器 | 成员＋绘图唯一；成员、绘图删除级联 |
| `assistant_runs` | 指令任务、控制状态、接收位置、执行端与租约 | 会话内最多一个未结束任务；凭据身份保留用于审计，不存明文凭据 |
| `assistant_messages` | 用户、AI 与暂停/继续/取消消息 | 会话＋序号唯一；会话＋来源＋请求标识唯一 |
| `assistant_events` | 有序状态与结果事件、执行回报去重凭证 | 会话＋序号唯一；会话＋请求标识唯一 |

消息和事件分别有事务内序号。事件载荷为受控结构，包含消息引用、任务状态或进度；不写入令牌、推理过程和环境变量。

## 状态与控制

- 任务状态：`queued`、`running`、`awaiting_input`、`completed`、`failed`、`cancelled`。
- 期望控制：`running`、`paused`，与执行端已确认控制版本分开。
- 执行端观察状态：`working`、`paused`、`awaiting_input`，连接是否在线由租约是否有效推导。
- 暂停/继续、新指令和取消推进 `controlVersion`。同一状态的重复控制不额外推进版本。
- 执行端通过 `acknowledgeRun` 确认控制版本及已读取的消息序号；进度或终态回报必须基于最新已确认输入。
- 终态不可转回运行；下一条用户指令创建新任务。

## 执行端身份与租约

身份由成员 ID、稳定凭据类型与 ID、worker ID 构成。支持现有个人令牌和 OAuth grant；每次工作写入检查凭据仍存在、属于该成员且有效。显示名称不作为身份。租约包含代次和到期时间；重新领取推进代次。暂停时保留心跳和确认能力，但禁止处理结果写入；取消立即使工作写入失效。

REQ-004 负责运输层认证与连接选择。此需求只交付可校验稳定身份的服务接口。

租约当前为 60 秒。执行端应独立于推理过程续租；续租不推进接收位置，也不确认控制。超时由读取时间判断，不依赖常驻计时器。重新领取必须重新确认当前输入，即使同一 worker 再次领取也会增加代次。

## 已实现的服务契约

入口为 `createAssistantStore(db, clock?)`；clock 仅用于可信内部调用和可重复测试。方法在入口运行 Zod 校验，抛出带 code 的 `AssistantError`。

| 方法 | 核心输入 | 返回 |
| --- | --- | --- |
| `getOrCreateConversation` | 成员 ID、drawingId | 唯一会话 |
| `getConversation` | 成员 ID、conversationId | 会话、当前任务、最后任务 |
| `sendInstruction` | 成员 ID、conversationId、requestId、body | 消息与所属任务 |
| `listMessages` / `listEvents` | 成员 ID、conversationId、afterSequence、limit | items、nextCursor、hasMore |
| `controlRun` | 成员 ID、conversationId、runId、requestId、command、expectedControlVersion | 控制消息与任务 |
| `claimRun` | WorkerPrincipal、conversationId、runId | 带租约代次和期限的任务 |
| `getWork` | WorkerPrincipal、conversationId、runId、消息游标 | 当前任务与有界消息页 |
| `renewLease` | WorkerPrincipal、conversationId、runId、generation | 续租后的任务 |
| `acknowledgeRun` | 同上，加 controlVersion、throughSequence | 已确认控制和接收位置的任务 |
| `reportRun` | 同上，加 requestId、kind、body | 持久化事件与 AI 消息回执 |

成员侧六个服务端函数位于 `server.ts`，全部使用现有 authMiddleware，成员 ID 来自 session。worker 方法未暴露成网页接口；后续 REQ-004 从经过认证的 MCP 请求构造 WorkerPrincipal，再调用这些方法。

消息最多 10,000 个 Unicode 码点；分页默认 50、上限 100；拒绝 PostgreSQL 无法保存的 U+0000。控制消息以 pause/resume/cancel 类型记录，正文为 null，界面文案由后续国际化提供。

worker 已经提交的同一回报可以重读原回执；它不会改变后来暂停或完成的任务。新回报必须持有当前租约、当前控制版本，且已确认最新输入。`completed` 只表示任务执行端报告完成，场景持久化证明由 REQ-003 的操作回执补充。

常见错误码：`not_found`、`invalid_input`、`idempotency_conflict`、`invalid_transition`、`run_busy`、`lease_lost`、`stale_control`、`paused`、`input_unacknowledged`、`credential_revoked`。

## 事务、锁与幂等

写操作统一按绘图、会话、任务、凭据顺序取锁。绘图共享锁防止操作期间被删除或移入回收站；会话行锁串行分配序号与创建任务；任务行锁保护领取和控制。数据库部分唯一索引补充单活跃任务保证。

成员请求先查已有去重消息，再决定创建任务或变更控制，避免旧请求在重试时建立新任务。执行端回报使用包含任务、租约代次和请求 ID 的去重键，并比较请求摘要；确认已提交的同一回报可以在任务结束后安全重读。

补充指令后，旧版本回报拒绝。控制版本和租约检查将在 REQ-003 的场景提交事务中复用；本需求不宣称已实现画布提交屏障。

## 权限与生命周期

会话读写同时检查 `conversation.userId` 和现有 `accessibleTo(drawings, userId)`。回收站允许读取历史，禁止新会话和工作写入。对外缺失与越权统一返回 not-found。账号或绘图永久删除通过外键清理本需求数据。

凭据撤销后每次工作写入立即拒绝；自动取消、通知和恢复调度由 REQ-008 实现。

## 风险与验证

- PGlite 串行事务不能证明 PostgreSQL 行锁正确，必须补充真实数据库并发验证。
- 未提交请求不能产生部分消息或事件；故障后的相同请求必须可去重。
- 执行端读取到最新消息不等于已处理完毕，两者通过接收位置和结果事件分开表示。
- 当前 `getTableColumns(drawings)` 会暴露新增绘图列，本需求只增加独立表，绘图写入字段在后续需求单独设计。
