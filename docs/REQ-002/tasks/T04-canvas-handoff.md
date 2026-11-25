# T04：画布交接与自动保存

状态：已完成。依赖：T01、T03。

方案：为 useAutoSave 增加同步 hold/drain/release，暂停时取消 debounce 并阻止执行。useDrawingWriter 从 API 取得最终快照和已提交版本，成功后立即更新模式缓存；DrawingCanvas 通过 context 向后续面板提供 prepare。其他标签页从列表标志或拒绝答复转 Room，保留本地元素。

验证：已有保存排空、编辑期间保留、重复 prepare 去重、失败恢复、版本冲突不覆盖、Room 初始化和错误状态。

结果：hold/drain、prepare 去重、失败释放、冲突暂停及单向 Room 切换已实现；React hook 测试通过，见 [验收](../VALIDATION.md)。
