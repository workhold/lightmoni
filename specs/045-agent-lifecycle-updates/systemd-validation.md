# Agent 维护器验证

## 真实 Linux/systemd

2026-10-30 在本机既有 Colima `lightmoni-release` 中创建独立 Debian 12 / arm64 / systemd 252 容器，使用真实旧版 0.1.0 Node 发行包首装、真实当前 runtime/SDK 构建新包。普通 Agent 始终以 `lightmoni-agent` 用户运行；维护器由 root 独立 transient systemd unit 执行，start 进程返回后继续运行。未连接或修改 vchive、生产平台。

最终维护器补充审批绑定 `expected_service_active` 后，重建隔离容器、替换当前维护器，并复用已构建的真实 Agent 程序包重跑原八项；另补一组真实运行状态变化拒绝检查，共九组。执行维护器 SHA256 与仓库当前文件逐字节核对，见 [systemd-report.json](systemd-report.json)：

1. 旧 0.1.0 → 新协议 A：新 boot、目标 digest/build、已应用配置的新心跳后 commit 成功。
2. A → B：version 相同，通过不同 build/digest 精确识别并确认成功。
3. B → 保留 A：重新审批式 rollback，等待 A 的新 boot/心跳后确认成功。
4. 实际 systemd ExecStart 失败：自动恢复 A 的程序、launcher/unit，并恢复运行。
5. 健康新进程未获 commit：确认期限后自动恢复 A。
6. 升级旧 0.1.0 失败：自动恢复旧程序指纹和原服务，身份/配置保持。
7. 真实 `/v1/logs` 接收的非空 pending 队列在旧版升级中保留；新进程实际新心跳后 commit。
8. 同一非空 pending 队列在失败自动恢复中保留。
9. 审阅时服务停止、执行前已运行，以及审阅时运行、执行前已停止，两种状态变化均以 `service_state_changed` 拒绝；没有创建事务或生命周期锁，当前程序指纹保持不变，检查结束恢复原运行状态。

非空队列案例比较 `batches` 中 id、signal、table、service、payload 的集合 SHA256，且保持主机身份和配置文件 SHA256。fixture 将 next_ns 设置为未来以隔离正常转发消费；不把动态 SQLite 文件字节或重试 attempts 不变当作业务要求。前五项当时队列为空，另补两项非空数据证明，避免将空集合检查视为数据保留验收。

隔离中心为 HTTP fixture，真实接收 Agent 注册、配置与心跳。成功操作的测试驱动器先核对同一 Agent 的新 boot_id、目标包摘要/build、config_revision 和空 last_error，再调用固定 commit，随后继续读取 succeeded。它验证维护协议与真实运行身份；生产 API 的审批、下载票据、持久编排及故障注入由独立集成测试覆盖。

构建同时产出 amd64/arm64 包，校验官方 Node 摘要及 ELF 架构；本次仅 arm64 进行了真实 systemd 执行。临时容器在证据导出后删除，Colima profile 由主任务停止恢复初始状态。

## 隔离执行器与首装回归

`runtime/test/agent-update-runner.test.ts` 使用真实维护器代码、隔离文件树和受控 systemd 命令（不声称真实 systemd），覆盖 19 项：同版本升级、新 boot 提交、legacy 超时恢复、启动失败恢复、恢复失败保留锁、包篡改、启动期限、TAR 越界软链接、任务互斥、旧指纹改变、只读核对、错误 boot、生产 `/` 路径边界、未知 systemd 派发保留回执/锁、schema 与旧回退目标拒绝，以及来源运行状态的必填校验、启动前变化和 worker 准备期间变化拒绝等。

`runtime/test/install-release.test.ts` 的 14 项首装/维护回归通过，新增安装摘要不改变身份、凭据、队列及其权限。runtime 类型检查和 `git diff --check` 通过。

## 维护边界

升级不恢复旧队列快照、不变更 config/identity，不跨 state_schema。旧受管 0.1.0 可作为升级源或自动恢复目标；没有完整 release/boot 协议的旧包不能成为主动回退目标。程序路径必须 root 所有且禁止业务用户写入；程序指纹用于审批一致性，不宣称防御持有 root 权限的攻击者修改整个依赖树。掉电或 SIGKILL 后保留持久回执和锁用于核对，不自动重放破坏性动作。
