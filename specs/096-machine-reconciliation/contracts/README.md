# Contracts

## Provider
register({kind,category,collect,reconcile})；collect(): DesiredResource[]，字段 key/machine_id/agent_id/owner_id/actor/desired/summary/dependencies。reconcile(resource): Promise<{state,code?,job_id?}>；state 为 in_sync/pending/drifted/blocked。业务 provider 负责实际观测与幂等应用，必须保留权限、归属、unknown 和绑定守卫。核心不执行任意命令。

## Administrator API
GET /api/v1/reconciliation/providers：已注册种类和类别。
GET /api/v1/machines/:id/reconciliation：machine_id、providers、resources（正文与 actor 不公开，仅来源、键、目标、代次、摘要、白名单 summary、观测和调度状态），limit/offset（默认100、最大1000）及 total。
POST /api/v1/machines/:id/reconciliation：管理员触发该机器到期检查；不授予新权限，不绕过未知执行守卫。不接收任意 desired/payload。

## Agent configuration
GET /api/v1/agents/:id/config 延续现有结构。heartbeat 新增 config_observation:{runtime_hash,persisted_hash}，摘要取规范化 RemoteConfig（包含 revision），缺失或非法摘要不视为已核验。Agent 每轮对当前内存和真实 remote-config.json 重新计算摘要，不依赖 revision 是否相同；发现差异原子持久化后应用。旧 Agent 保持配置下发可用，但清单显示等待实际观测。

## Actual deployment verification
workload.inspect/gateway.inspect 的期望配置可选；若带期望，回执增加 configuration_matches。不匹配表示漂移而非成功应用。旧日志/回执不会确认新的期望。特权正文仍只经现有加密、签名通道。

## Registration example

```ts
registry.register({
  kind: 'example.config', category: 'custom',
  collect: () => [{
    key: 'settings', machine_id: 'machine-a', agent_id: 'agent-a',
    owner_id: 'example-service', actor: 'approved-admin',
    desired: { version: 1, settings: { enabled: true } },
    summary: { service: 'example-service' },
  }],
  reconcile: async resource => {
    // Check current authorization and binding. Compare actual owned state;
    // enqueue a bounded, idempotent operation through the existing executor.
    return exampleController.inspectAndEnsure(resource);
  },
});
```

管理器必须提供完整快照；summary 仅放公开元数据。不要从历史成功回执直接返回 in_sync；删除时先核验归属，unknown 不重放。未注册管理器的旧数据保留并阻塞；引用方未清理时依赖删除阻塞。

## Certificate lifecycle and rollout

目录目标新增显式 remove 动作：持久记录 cleanup_requested，分机器删除受管发布入口并实际核验；在清理完成前删除目标返回 409/remove_certificate_files_before_deleting_target。关闭 enabled 只暂停自动追随新证书，不隐式删文件；明确手动同步的逻辑版本保留为期望。

深度核验/修复作业要求 operations.platform.reconciliation.v1。中心先升级而机器尚未升级时，清单显示 reconciliation_agent_upgrade_required；原有轻量健康检查和证书下发继续运行，避免升级窗口的观测中断。普通 Agent 的写入权限没有增加。
