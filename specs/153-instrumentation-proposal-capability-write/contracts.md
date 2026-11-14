# SDK 插桩提案契约

`lightmoni_code_instrumentation_plan` 输入 `{workspace,intent,base_revision?,service?,env?,mode?,table?,metric?,reason,idempotency_key}`，要求 code.workspace.propose + code.workspace.detail.read、admin、allHosts=true。

返回 `{proposal,plan,applied}`。proposal 含 id/operation/status/native_status/review_url；status=awaiting_approval 只表示等待人工审批，completed 只表示原生 Apply 已接受/完成，不代表遥测验证。MCP plan 为安全摘要，完整 Diff 由管理员通过 review_url 读取；内部助手返回原完整 InstrumentationPlan。

外部来源在同一 SQLite 事务中接受加密计划、幂等记录和 domain=instrumentation 的稳定 grant。Apply 前复验；无绑定、撤销、过期、降权均不得写入。内部/历史无来源计划保持原行为。

同 key 同规范化输入返回原计划，异输入 idempotency_conflict。request hash 包含能力版本但不包含 base_revision；base_revision 只保存在目标快照，目标变化后的同 key 重试仍返回原计划。路径、操作、文件内容和结果 revision 继续由原领域校验。无 Apply/审批、code_task 或直接执行工具。
