# 实施任务

- [x] T01 同步 main，确认依赖 PR 状态并创建 stacked 功能分支。
- [x] T02 编写告警只读 Slice 的 spec、plan、contracts 和 tasks。
- [x] T03 实现 AlertReadService、兼容 publicAlertValue 和共享提案服务装配。
- [x] T04 注册告警读取描述符、详情 Scope、角色和内部助手适配器。
- [x] T05 更新 MCP 接入页标签及架构/接入文档。
- [x] T06 添加读取、筛选、权限、owner、成员和官方 MCP 客户端测试。
- [x] T07 运行定向/全量测试、基线对比、类型检查与构建，记录验证证据；5 项 main 基线失败单独披露，不宣称全量通过。
- [ ] T08 审查、提交、推送并创建面向 main 且注明依赖 #186/#187/#188 的 PR，不自动合并。

## 后续

告警写入属于 Slice 3；日志、Trace、大盘、部署、运维和其他 Slice 2 领域仍需独立迁移。
