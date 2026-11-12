# SDD129 验收记录

日期：2026-11-12。分支：`codex/129-ssh-legacy-queue-failure`。

## 行为

- 旧 helper 缺少 `managed-once` 时，升级前已排队的受管 `agent_jobs` 在桥接准备阶段通过现有 `failQueuedSSH` 进入 `failed`，回执和事件均保留 `agent_upgrade_required`；领域 `ops_runs` 同步为 `failed`。未创建 `privileged_jobs`，因此没有 SSH 派发候选。
- 已领取或 `unknown` 的记录仍由 `failQueuedSSH` 的 `queued` 限定保护；其他审批错误继续原取消分支。

## 本地验证

- `runtime/`：`node --import tsx --test test/managed-executor-jobs.test.ts`，35 项通过、0 失败。新增用例覆盖旧发行的已排队定时受管作业、有效 SSH 绑定、签名 helper 心跳、原作业与领域结果，以及没有签名作业；同一文件原有正常发行和审批失效回归继续通过。
- `runtime/`：`npm run typecheck` 通过。
- `git diff --check` 通过。

## 架构影响

不适用。仅修复既有桥接的终态与错误码，复用原 Agent 作业失败、事件和领域通知；组件职责、控制路径、身份与凭据边界、协议、存储和部署拓扑均未改变。仓库系统设计第 127 章和 Doca 在线基线已有“未领取旧队列升级失败”原则，本 SDD 不改写设计正文。
