# SDD129：历史特权队列的升级失败码

**分支**：`codex/129-ssh-legacy-queue-failure`
**日期**：2026-11-12
**状态**：实施中

## 背景

SDD127 已在中心 SSH 派发前检查单次入口。对升级前遗留的 `agent_jobs` 特权队列，中心先通过受管桥接准备签名作业；当当前 helper 缺少 `managed-once` 时，桥接把 `agent_upgrade_required` 包装为 `approval_invalid` 并取消原作业。远端没有执行，但最终状态和错误码是 `cancelled`，与升级失败的实际原因及 SDD127 契约不一致。

## 用户场景与验收

管理员查看升级前已排队、尚未领取的受管作业时，能看到终态 `failed` 和稳定错误码 `agent_upgrade_required`，据此升级目标 Agent 后重新生成计划。

1. 给定已经排队的特权 `agent_jobs`，当前绑定 helper 的认证心跳缺少 `managed-once`，当中心准备 SSH 派发时，原作业以 `failed` 和 `agent_upgrade_required` 终结，且不会创建签名 `privileged_jobs` 或连接 SSH。
2. 给定受管准备阶段的其他审批或资源失效错误，原有取消行为保持；不把它们误报为 Agent 升级问题。
3. 给定作业已领取或处于 `unknown`，升级判断不覆盖现有租约、审计和恢复围栏。

## 要求

- **FR-001**：仅对受管桥接中明确的 `agent_upgrade_required` 采用现有 `failQueuedSSH` 终结原 `agent_jobs`，保留精确错误码。
- **FR-002**：失败转换必须仅影响尚未领取记录，且调用现有事件与领域回执同步；不可创建新的远端执行或重放路径。
- **FR-003**：其他 `HTTPError` 沿现有取消路径处理；异常仍向上报告。
- **FR-004**：测试覆盖旧发行队列与正常兼容发行路径，确认签名作业没有被旧发行创建。

## 架构影响

不适用。本次只修正已有受管队列准备阶段的终态和错误码，复用现有 `failQueuedSSH`、事件与领域同步；组件职责、认证与 SSH 控制路径、协议、凭据、存储结构及部署拓扑均不变。仓库系统设计第 127 章和 Doca 基线已有对应升级失败原则，无需无意义改写。
