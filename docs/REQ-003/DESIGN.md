# REQ-003 技术方案

Room 对元素、设置、flush 和后台命令使用同一短串行队列。后台读取/提交临时保留 Room，无座位也可执行，完成后清理空 Room。模型推理在队列之外。

事务按 drawing（update）、conversation、run、credential 的固定锁顺序验证成员访问、回收站、单向模式、租约、控制版本及输入确认。使用现有 planEdit 生成有限元素增量；必须提供所有被触及旧元素的 version/versionNonce，依赖标签和连接线也检查。只替换增量，保留无关并发修改；设置仅比较实际修改字段。

新增 assistant_operations，记录请求摘要、受影响元素前后内容、设置变化、保存 revision。场景、操作及 scene_committed 事件同事务写入，提交后才更新 Room 和广播；请求 ID 相同内容不同则拒绝。回执重放不再执行修改。失败不改变内存。暂停和提交按数据库锁线性排序。

权限授权来自成员网页启动的任务，沿用原绘图权限；旧 edit_drawing 的逐次提案行为保持。新增 ADR 明确区分这两种入口。撤回接口在 REQ-007 完成。
