# 后端生命周期验证

## 已实现的边界

- 首装记录持久化执行阶段和本次安装预约；预约创建与阶段关联在同一 SQLite 事务完成。平台重启或安装已派发后的 SSH 中断进入 `unknown`，保留健康核对所需身份，不自动重放安装。
- 管理员可只读核对原 SSH 目标，也可填写原因明确结束。成功核对要求原主机及替换身份匹配的预约、当前 Agent 绑定、有效控制凭据、完整受管程序、运行服务、无本地操作锁，以及本次开始后新鲜且版本和架构一致的健康心跳。
- 人工结束保留 `unknown` 历史，只取消本次未激活预约、撤销本次新 Agent 的控制和数据凭据；不撤销原 Agent 或其他主机身份。未结束有限任务会阻止结束。
- 未结束的 `running` / `unknown` 安装记录阻止冲突生命周期操作和有限任务派发、领取、调度与重试；已明确结束的历史不再阻塞。持续心跳、SSH 检查与人工终端保留作恢复通道。
- 阶段 CAS 和条件回执阻止旧进程的迟到预检或安装响应在恢复结束后签发身份、派发安装或覆盖人工结论及较新主机状态。
- 首装执行前重新核对架构；卸载识别通用脚本任务标记；卸载使用凭据同步更新主机绑定与集中凭据源的最近使用时间。

## 回归及结果

最终后端组合 **186 / 186 通过**，包含以下 15 个文件：

```sh
cd runtime
node --import tsx --test --test-concurrency=1 \
  test/managed-machines.test.ts \
  test/machine-installation-recovery.test.ts \
  test/machine-installation-recovery-races.test.ts \
  test/agent-credentials.test.ts \
  test/task-center.test.ts \
  test/task-schedules.test.ts \
  test/agent-jobs.test.ts \
  test/machine-agent-updates.test.ts \
  test/connection-credentials.test.ts \
  test/machine-host-identity.test.ts \
  test/host-observed-identity.test.ts \
  test/machine-ssh-discovery.test.ts \
  test/agent-host-admission.test.ts \
  test/machine-agent-link.test.ts \
  test/machine-agent-lifecycle.test.ts
```

其中，新增通用恢复 10 项和独立迟到竞态 3 项合计 **13 / 13 通过**。通用恢复测试包含 15 种不满足成功条件的证据，覆盖身份、预约归属、心跳、构建、程序、服务与本地锁；还覆盖管理员授权、请求校验、固定 SSH 目标、换用有效凭据、人工结束的精确撤销和持久屏障。

旧 admission 回归已按新契约更新：激活后传输丢失保留身份并进入未知，禁止直接重装；管理员明确结束后，仍需新鲜 absent 预检才能创建同一主机的新安装。

Runtime `npm run typecheck` 与 `git diff --check` 通过。完整 runtime、全仓构建和浏览器结果由主验收记录汇总。

## 证据与限制

已先用失败回归确认集中凭据源使用时间遗漏、本地脚本任务标记遗漏、执行架构变化未复核；修正后对应回归通过。旧首装重启遗留 `running` 的最小复现以及各轮测试日志保存在仓库外的本地 `.local-dev/evidence/host-agent-audit/`，不含生产连接秘密。独立迟到竞态的修正前后证据见 [恢复独立复核](recovery-independent-review.md)。

测试使用内存 SQLite、真实 HTTP 路由与受控 SSH 响应；通过复用数据库重新装配 Router 模拟平台重启。没有访问生产或 vchive，没有执行真实 SSH / systemd，也没有模拟 OS 级进程崩溃。人工结束不会停止远端进程，正常卸载保留 identity/config，本轮没有放宽 fresh 安装覆盖保护。
