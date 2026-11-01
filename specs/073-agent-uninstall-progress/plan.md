# 设计

1. MachinesPage 在操作区域增加已有卸载流程入口。使用既有 last_uninstallation_status 与能力 reason 判断是否显示；点击重新读取主机详情，在 uninstallations 中优先选择 awaiting_approval/running/unknown，再 GET 该记录，沿用请求目标隔离机制。若记录已变化，只恢复最新持久记录，不发起新计划。
2. 卸载对话框保留独立请求锁，增加只读状态轮询。apply 的请求等待与轮询分离；轮询串行、有界间隔，依附当前记录，在卸载完成或组件销毁后停止。使用读取世代避免迟到 GET 回滚已确认状态。
3. 观测仅展示服务端粗粒度状态。awaiting_approval + applyAttempted 表示请求已发送；running 表示正在卸载；成功仅依据 succeeded 与回执。轮询失败使用独立提示，不清除原错误或解锁重复 apply。
4. 对话框使用既有 Modal 布局，状态与当前操作固定在可滚动正文外。awaiting_approval 的取消不受 applyAttempted 阻止，仍受 busy 与 refreshNeeded 保护，并由服务端验证实际状态。
5. 扩展现有卸载浏览器 fixture；测试延迟 apply、跨标签页状态变化、迟到 GET、过期取消、原流程恢复及主机能力刷新。运行相关类型检查、网页构建和现有恢复卸载回归。

架构同步：不适用，理由见 spec.md。
