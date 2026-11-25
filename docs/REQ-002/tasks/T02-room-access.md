# T02：私人 Room 与生命周期

状态：已完成。依赖：T01。

方案：扩展按 ID resolver，接入已启用私人绘图 owner 和图片端点。Room 缓存模式，启用时更新现有 Room。记录 seat 的分享 token 哈希；在串行拓扑队列内撤销旧 token，不影响新链接和独立成员访问。账号删除查出未分享服务端私人 Room。

验证：owner/其他成员/访客/回收站准入；撤销时签入访客离开、owner 保留、新 token 保留；关闭与恢复保存。

结果：已实现 ID 准入、分享哈希撤销及账号私人 Room 清理；resolver/token/Room 测试通过，见 [验收](../VALIDATION.md)。
