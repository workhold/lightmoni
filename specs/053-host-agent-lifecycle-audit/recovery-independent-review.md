# 首装恢复独立复核

## 发现与修正

复核 `machine-installation-recovery.ts`、`machine-installations-guard.ts` 和主机安装集成时发现：旧 apply 的 SSH 预检返回后未重新检查安装状态，后续阶段更新没有检查实际更新行数；重启将 running 记为 unknown、管理员明确结束之后，旧请求仍可能签发预约及派发安装。旧预检失败还会将已人工结束的 unknown 历史改为 failed；已派发请求的迟到回执可能覆写较新的主机错误信息。

后端修正阶段 CAS、预约和阶段的同事务持久化、派发前 CAS，以及仅由仍然有效的安装请求保存结果和主机错误。独立测试只增加竞态回归，不改实现。

## 复现证据

新增 `runtime/test/machine-installation-recovery-races.test.ts` 使用两套 Router、一个内存数据库和受控延迟 SSH 响应。第二套 Router 模拟新实例启动，将第一套请求的 running 迁移为 unknown，再通过实际管理员恢复接口明确结束。

三个场景为：

1. 旧预检成功迟到：不再签发身份、不再调用 bootstrap，保留 resolved unknown。
2. 旧预检失败迟到：保留 resolved unknown、人工结论及原 finished_at，不覆写为 failed。
3. 旧 bootstrap 成功回执迟到：不覆写人工结束记录，也不覆写之后写入的主机状态。

发现后实现已由后端代理并行修正。为保存修正前证据，在仓库外按本次审查时读取的原代码块重建阶段 CAS 和条件 catch 修正前快照，以相同三项测试重放，得到 **3/3 失败**：新签发次数为 1、unknown 被改为 failed、较新主机状态被旧 unknown 错误覆写。未回退或改写共享工作区源码。

当前源码运行：

```sh
cd runtime
node --import tsx --test --test-concurrency=1 test/machine-installation-recovery-races.test.ts
```

结果：**3/3 通过**。隔离重放日志位于 `/tmp/lightmoni-053-recovery-races-before.tap`，当前验证日志位于 `/tmp/lightmoni-053-recovery-races-after.tap`；日志不是交付所依赖的仓库文件。

最终版本再联合运行通用恢复与独立竞态回归：

```sh
node --import tsx --test --test-concurrency=1 test/machine-installation-recovery.test.ts test/machine-installation-recovery-races.test.ts
```

结果：**13/13 通过**。已回读最终 `ownEnrollment` / `cancelOwnEnrollment`：取消预约和撤销身份都检查原始预约的主机及替换身份，错误关联不会取消另一主机票据；回执中的取消标记反映实际取消结果。该项额外归属加固及通用恢复回归由后端代理完成。

复核结论：在本轮 SDD 契约与上述隔离验证范围内未发现剩余阻塞，源码可冻结进入整体检查。

## 复核范围与限制

- 旧 running 迁移为 unknown；旧阶段默认 legacy_unknown，不推断从未派发。planned/preflight 明确无预约，以及尚未派发且未激活的 enrollment_issued 才可记录未派发。
- reconcile 在连接前及提交结果前核验原 SSH target revision，提交时重新检查所选凭据仍有效。成功必须同时满足原预约 active、当前主机关联、有效 control、同一远端 Agent 的完整受管服务、无操作锁、新鲜且不早于本次开始的心跳、版本/架构和无 Agent 错误。
- resolve 必须管理员、明确确认和非空原因；保留 unknown 历史。未结束有限任务阻止结束；仅精确本次新 Agent 身份可撤销。相关生命周期、有限任务提交/领取和自动调度都读取持久安装屏障。
- 测试仅模拟本地 HTTP、SQLite 和 SSH 响应，没有访问 vchive、真实 SSH/systemd 或生产，不宣称远端实机验收。未测试 OS 级进程崩溃；第二套 Router 模拟持久恢复与迟到异步响应。
- 整体类型检查、构建、Doca 架构同步和 PR 验证由主验证记录汇总。
