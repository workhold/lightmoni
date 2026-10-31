# 中心 API 验收

2026-10-30，本机执行。以下使用真实 SQLite、HTTP 路由和凭据加密，SSH 远端以可控执行器注入故障；不代表生产主机或真实 systemd 验收。

`node --import tsx --test --test-concurrency=1 test/machine-agent-updates.test.ts`：25/25 通过。

- 相同 version 的不同 build/digest 能识别和升级，批准后使用持久内容寻址缓存；原发行目录替换不改变已审批字节，缓存篡改拒绝。
- 新 boot、精确 source/build/SHA、已同步 config_revision 且 last_error 为空才能请求 commit；commit 返回 waiting 后继续等待持久成功。
- 自动回退验证恢复原程序指纹；主动回退重新审批并通过同样健康检查。
- 审批过期、程序变化、来源运行状态在计划后变化、架构不匹配、重复 apply、缺少可验证身份的旧回退目标全部拒绝。
- 中心 apply、维护器 start 和 worker 切换前均绑定审批时的 service_active；active↔inactive 变化拒绝旧计划。worker 明确未切换且原程序停止时，可核对为 failed，不因来源不在线而遗留 unknown。
- 下载票据仅在 SSH stdin，散列保存并限定主机、操作、文件、有效期；启动后失效。
- SSH 断连保持 unknown；只读核对不能提交等待确认的升级。没有回执时，启动截止时间结束后还需确认原程序、身份和无维护锁才能判定未执行。
- 新任务、领取、部署/卸载、删除和终端与维护互斥；定时派发跳过单台维护主机，不阻塞其他主机，也不补发遗漏周期。
- 批次串行，失败暂停，明确继续可跳过已确认终态；单机端点不能绕过批次顺序。取消只取消未启动项，重启保留 unknown 并暂停运行批次。
- 成员只读，管理员审批，HTTP 外部地址无效时不连接、不遗留 running。
- 提交响应丢失后 Agent 再次自然重启，核对独立验证当前 boot 并保留原提交 boot，能解除已成功事务的未知阻塞。
- 当前受管程序故障停止时可以审阅回退；普通升级仍要求来源健康。若该回退失败，核对恢复的原程序指纹及原停止状态，明确记录“已自动回退，原服务仍停止”，不因原服务本来未运行而永久停在 unknown。

相关旧回归：`node --import tsx --test --test-concurrency=1 test/managed-machines.test.ts test/machine-agent-lifecycle.test.ts test/node-lifecycle.test.ts test/task-center.test.ts test/agent-jobs.test.ts test/assistant-agent-updates.test.ts`：88/88 通过。

`npm --prefix runtime run typecheck` 与 `git diff --check` 通过。

## 人工恢复边界

掉电、强制结束维护进程或无法确认 systemd 独立单元是否启动时，持久回执可能停在 accepted/preparing/switching，平台保持 unknown。此时通过平台外的 SSH 人工检查 `lightmoni-agent-update-<operation_id>` 单元、`lightmoni-agent.service`、`/opt/lightmoni-agent/updates/<operation_id>/status.json` 与实际程序指纹；不能因为一次无锁观察就认定维护结束，也不能直接清锁后重跑。平台的核对接口只读取并核验已有回执，不代替人工恢复。
