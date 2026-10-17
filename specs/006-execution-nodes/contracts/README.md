# Interface contracts

[上级 contracts.md](../contracts.md) 是本功能的接口契约，定义命名、管理 API、权限、匹配合并规则和旧节点兼容。运行时继续使用既有 `agent.RemoteConfig`，没有新增远程执行协议。

验收对应：`internal/server/agent_tasks_test.go`（权限及事务）、`agent_task_migration_test.go`（升级兼容）、`agent_task_runtime_test.go`（真实旧节点循环），以及 `web/src/app/verify-execution-nodes.mjs`（隔离页面交互）。
