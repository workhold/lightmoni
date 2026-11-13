# 实施任务

- [x] T01 同步 main，确认 SDD 134/135 和 PR #186/#187 状态，创建 stacked 功能分支。
- [x] T02 编写遥测只读 Slice 的 spec、plan、contracts 和 tasks。
- [x] T03 抽取 TelemetryService 并实现行/字节有界查询。
- [x] T04 注册目录/表结构/查询描述符、Scope、角色与内部助手适配器。
- [x] T05 更新 MCP 接入页标签及架构/接入文档。
- [x] T06 添加领域、权限、采样、内部助手和官方 MCP 客户端测试。
- [x] T07 运行定向/全量测试、基线对比、类型检查与构建，记录验证证据；5 项 main 基线失败单独披露，不宣称全量通过。
- [x] T08 审查、提交、推送并创建面向 main 且注明依赖 #186/#187 的 [PR #188](https://github.com/workhold/lightmoni/pull/188)；已获本次用户授权合入。

## 后续 Slice 2

日志、Trace、大盘、告警、部署、运维、主机与 Agent 等其余只读领域仍需逐领域迁移，本切片不代表 Slice 2 全部完成。
