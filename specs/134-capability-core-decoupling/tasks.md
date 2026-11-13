# 实施任务

- [x] T01 基于最新 main 创建功能分支，确认工作区和现有 SDD 046/047 边界。
- [x] T02 编写 Slice 0 的 spec、plan、contracts 和 tasks。
- [x] T03 实现核心 Session/Capability Access 与可选外部授权适配器。
- [x] T04 解耦应用装配，始终启用 Dispatcher、能力 HTTP 和内部助手共享工具。
- [x] T05 增加无 MCP 的核心、HTTP、内部助手和外部提案失败关闭测试。
- [x] T06 更新系统设计、平台 MCP 架构和接入文档。
- [x] T07 运行相关回归、runtime 全量测试、全仓类型检查与构建，记录验证证据；5 项 main 基线失败单独披露，不宣称全量通过。
- [x] T08 审查差异、秘密扫描、提交并推送功能分支，创建面向 main 的 [PR #186](https://github.com/workhold/lightmoni/pull/186)；未经授权不合并。

## 后续 Goal 范围（不属于本切片）

- [ ] Slice 1 描述符、输出 Schema、稳定错误码与协议完善。
- [ ] Slice 2 各领域只读能力垂直迁移。
- [ ] Slice 3 各领域完整提案闭环。
- [ ] Slice 4 跨领域索引、OpenAPI 与普通程序 Bearer。
- [ ] Slice 5 服务主体与受控自动化；高风险直接执行另行评审。
