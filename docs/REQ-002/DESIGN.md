# REQ-002 技术方案

## 写入模式与版本

drawings 新增 `serverManagedAt`（nullable timestamp）与 `sceneRevision`（非负整数）。首次启用时写 serverManagedAt，之后没有撤销入口。单向模式本身就是旧写入的屏障，不再额外建立可回退 epoch；sceneRevision 用于最终快照的 compare-and-swap。

自动保存每次成功推进 sceneRevision 并返回客户端；Room 保存同样推进。启用请求包含预期 sceneRevision 与完整场景/图片。事务锁住绘图行后重新检查权限、回收站、分享与版本：

- 已启用：幂等返回模式，不再次写旧快照。
- Team/已分享：只切换模式，不能写浏览器快照覆盖现有 Room。
- 未分享私人：预期版本一致时在同一事务保存场景/图片并切换；不一致返回冲突，不写任何内容。

共享拓扑变更（启用、停止/重建链接）用进程级按绘图串行队列协调数据库状态和内存 Room；队列只覆盖短变更，不覆盖 AI 推理。

## 浏览器交接

useAutoSave 增加可释放的 hold：同步阻止新保存，取消 debounce，等待已排队保存；编辑继续记录。交接 hook 读取最新 API 快照和缓存中的已提交版本，然后请求原子切换。成功更新列表/详情中的单向模式，画布通过 ID 加入 Room；期间新编辑在 join catch-up 中合并。失败释放 hold 并继续保存；不自动用过期快照重试版本冲突。

画布提供 DrawingWriterContext 的 prepare 方法，供 REQ-006 调用。没有 AI UI 时不自动启用所有绘图。其他标签页通过列表通知或保存拒绝发现模式，不用服务端旧场景替换本地编辑。

## Room 与访问

Room 额外缓存 serverManaged 标志。ID 准入允许 Team 或已启用绘图，仍检查 canAccess、session 和 deletedAt。图片端点复用同一 resolver。

分享来源 token 仅以哈希保存在服务端 seat，不加入参与者公开信息。撤销旧 token 时，只剔除依赖该 token 且无独立绘图权限的 seat。普通未启用 Private 的现有 handback 保持现有路径。owner 删除需查出包括未分享已启用绘图的全部私人 Room。

## 场景设置

仅已启用 Room 增加背景色、gridSize、gridStep、gridModeEnabled 的有限同步。SCENE_INIT 带设置和版本；SCENE_STATE 使用预期版本比较并回传权威设置。客户端跟踪待发送的局部变更，远端更新不回声，断线后重新基于最新版本发送本地改动。旧 Room 和旧客户端继续使用元素协议。

设置随 Room 场景同批保存，保留 JSON envelope 的其他字段。主题、选中项、视角、光标不进入共享设置。后台严格提交、无参与者命令和持久化回执归 REQ-003。

## 验证重点

真实 PostgreSQL 验证最终快照/图片的原子性和旧保存竞态；PGlite 验证迁移和权限。Room 测试验证链接撤销与设置 CAS；React hook 测试验证 hold、失败释放、远端无回声和离线改动。修改不依赖 Codex 在线。
