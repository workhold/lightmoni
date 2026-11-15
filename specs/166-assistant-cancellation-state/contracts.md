# SDD 166 契约

## 取消工具回执

取消时，后端为尚无结果的 pending tool 追加 `tool.result`，其 `status` 为 `cancelled`，`value.error` 保留取消原因。真实失败继续使用 `error`。取消原因仍是 `request cancelled` 或 `assistant turn reached its time limit`，本次不虚构手动停止或断连来源。

## 前端状态

`ToolTrace.status` 为 `running | success | error | cancelled`。`tool.result.status=cancelled` 直接映射为取消；`turn.cancelled` 将运行中工具及错误文本与整轮取消原因相同的历史待完成工具归一为取消，以兼容历史事件；已有不同错误文本的真实工具失败保持不变。`turn.failed` 不执行此归一。Cancelled 标签使用默认色并显示“已取消/Cancelled”。

## 实测边界

真实 SSH 仅执行既有固定只读 preflight，不审批或更新。MCP 测试仅使用 `hosts.read`、`agents.read` 和一台授权主机；越权及撤销后的拒绝是预期证据，不重试写操作。
