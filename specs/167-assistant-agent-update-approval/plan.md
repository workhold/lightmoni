# SDD 167 实施计划

1. 固定五类实测错误与现有 `AgentUpdatePlanSummary`、原生审批 API，新增助手记录解析、状态与路径回归测试。
2. 新增 `AgentUpdateProgress`，复用计划摘要；复核当前计划后由管理员勾选审阅并 apply，Popconfirm 取消，展示执行接受与真实后续状态。
3. 将组件接入 `ToolProgress`，更新发行目录指令与工具名称，保持真实失败原样可见。
4. 运行相关测试、类型检查、构建和文档检查；不执行生产升级或审批。
5. 同步 main、审查 diff、创建 PR；合入需用户另行授权，不直接 push main。
