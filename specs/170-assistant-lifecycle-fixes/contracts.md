# SDD 170 契约

## 摘要降级

- 空文本、`length`、超过 2048 UTF-8 估算字节的摘要响应属于“不合格摘要”，不是完整摘要。允许保留已有摘要并追加固定降级说明及 `degraded=true`。
- 降级说明不包含秘密、主机载荷或模型新生成的事实；当前用户消息、已有 checkpoint 和 `summary_through` 规则不得改变。
- 供应商异常继续返回 `summary_failed`。上下文超限继续使用 `context_limit`，不能用降级绕过输入预算。

## 更新轮询

- 只读取 `agentUpdateAPIPath(record)` 对应的同一原生记录，不接受工具结果提供的新 URL。
- 每个组件实例最多一个进行中的读取；终态或卸载后不得再请求。
- `succeeded` 才能显示更新成功；`rolled_back` 表示目标未通过健康确认且已恢复原程序；`unknown` 必须只读核对，不能报告成功。
- 主机列表的快速轮询只缩短已有只读刷新间隔；当前发行仍以 Agent 心跳和原生状态投影为准，不能用卡片终态伪造主机发行。

## 维护围栏

- `unknown` 继续归入 active/pending，阻止新的更新和卸载。Agent 在线状态和 Agent 是否存在是独立事实，离线不解除围栏。
- 允许的操作仅为原生只读核对或管理员明确选择的恢复卸载。禁止自动重装、重复派发、通用 apply/approve/execute 或强制清除 unknown。
