# 验证记录

最终被测维护器 SHA-256：`317af1d974fa8d8db07413e10ae027a1cbf7e66670752e14f00012dbc272449a`。本轮以本机隔离验证补全 SDD093 暴露的维护可靠性问题，没有将模拟结果作为 vchive 或生产环境的新版端到端验收。

## 分层验证与边界

| 验证层 | 结果 | 覆盖 | 证据边界 |
| --- | --- | --- | --- |
| 维护相关回归套件 | 206 项通过（含下行 90 项后端/probe） | 准备/总期限、切换前预算、磁盘与 inode、取消及各阶段故障、原快照和目标快照核验、恢复串行、原身份/代次、最终健康验证、退出证据与制品处理 | 文件、协议与维护 JS 回归；测试中的 Agent/systemctl 行为按夹具控制，不能代替真实主机升级验收 |
| 后端与 SSH probe | 90 项通过 | 管理员/确认/字段校验、恢复修订与固定 runner、替换核验凭据、账户快照、并发恢复、响应丢失、持久门禁、独立 probe 后归档；丢失 restore 响应后重新核验及 failed/rolled_back 各 12 类变化拒绝；真正内联 probe 源码的 64 KiB 哈希及指纹等价 | 本地 HTTP/数据库与实际内联源码测试；SSH 对端由受控夹具响应，没有连接生产主机 |
| 真实界面 | 24 项通过 | 恢复前审阅、运行中/无法核实结果、中英文文案、响应丢失后只读核对、刷新/重开持久门禁、凭据到期及续存复查、修订变化、错误身份回执、GET 超时/取消和长记录滚动 | 本地浏览器运行实际 TSX，接口由隔离夹具控制；没有执行生产安装、SSH 或恢复 |
| 真实 Linux/systemd | 32 项通过 | loaded/inactive、running、collected 单元；真实 cgroup 空/有进程/清空；真实 `/proc` worker；SIGTERM、超时、SIGKILL、退出码 7、正常退出和专用 cgroup OOM 的生产退出证据 | 专用 2 GiB Lima VM、官方 Node 24 ARM64、systemd 255/cgroup v2；使用虚拟 worker，仅 opDir 映射到 `/qa-recovery`，没有真实 Agent 身份或程序恢复 |

后端/probe 的 90 项属于上方 206 项相关套件，不重复计数；界面与真实 systemd 分层报告，不将不同夹具的通过数相加作为“全平台能力全部通过”。最终套件日志为 `/private/tmp/lightmoni-vchive-retest-20261104-092/fix094-final-all-tests.tap`，206 项通过、0 失败、0 跳过。

最终统一命令在 runtime 目录执行：`node --import tsx --test --test-concurrency=1 test/agent-update-extract.test.ts test/agent-update-runner.test.ts test/machine-agent-updates.test.ts test/agent-update-ssh-probe.test.ts`。extract 21、runner 95、后端 83、内联 probe 7，共206项不重复；早前199项日志没有包含内联probe，最终已用正确路径统一重跑。

后端最终回归日志为 `/private/tmp/sdd094-server-tests-final.tap`。常规 `npm run typecheck` 因工作目录缺少既有 MCP SDK 模块而报告三处缺失模块及三处连带类型推导错误；使用本机已缓存的真实 `@modelcontextprotocol/sdk` 声明和原 runtime tsconfig 做路径映射后，完整 runtime 离线类型检查通过，没有引入声明桩或修改仓库依赖。日志为 `/private/tmp/sdd094-server-typecheck-offline-final.log`；`git diff --check` 通过。

## 真实文件链路与资源限额

`final-systemd-budget.log` 记录最终 runner 在真实 Linux/systemd 资源单元中运行文件维护链路。环境同时保留 1 GiB 背景内存负载，维护单元使用 `MemoryHigh=384M`、`MemoryMax=512M`、`MemorySwapMax=0`、`CPUQuota=50%`、`TasksMax=64`、`RuntimeMaxSec=1200`。

完整 `start → worker → 最终 probe` 文件链路通过，耗时约 **5.86 秒**，进程峰值 RSS **97,004 KiB**，该完整阶段的 cgroup 峰值 **359,473,152 字节**，额外磁盘峰值 **769,470,464 字节**。完整阶段的 `memory.events` 中 `max/oom/oom_kill` 均为 0；RSS 不能解释为整机或整套平台的内存需求。独立准备阶段与完整阶段分开记录，不混用其峰值。

使用真实发行包：80,347,679 字节，SHA-256 `8fa62080999fe5bf930600c4e391437004b6d34c41d551c1ae846ee3030845c2`。SHA 校验、归档复制/解包、metadata/fingerprint、持久文件、程序指针切换和提交均执行生产 JS。外层 systemd/cgroup 资源约束真实生效；夹具内部的 systemctl、Agent check/status/activation 和权限准备命令由封闭白名单模拟，包内 amd64 Node、Agent、helper 和脚本没有执行。上一发行身份与 launcher 为测试夹具，不能据此声称真实 Agent 跨版本升级、健康心跳或回退已验收。

## 真实退出证据与局部 OOM

最终 SHA 重跑原有 26 项真实 systemd 检查，并增加 6 项专用 OOM 检查，32 项均通过。正常维护测试单元使用最终生产资源属性；OOM 测试单独使用 `MemoryMax=64M / MemorySwapMax=0`，令虚拟 Node worker 尝试分配 256 MiB，只在其自身 cgroup 触发 OOM。生产 `exitEvidenceScript` 经实际 `ExecStopPost` 留下：

```json
{"schema":1,"result":"oom-kill","exit_code":"killed","exit_status":9,"memory_peak_bytes":67108864}
```

虚拟事务的 status 和生命周期 fence 字节保持不变。SIGTERM 按 systemd 语义记录为 `success / killed / 15`，运行超时为 `timeout / killed / 15`，SIGKILL 为 `signal / killed / 9`；各场景都保留正的 MemoryPeak。瞬态单元被 `--collect` 收集后，systemctl 的历史字段已不可用，私有 `unit-exit.json` 仍保留。

首次 OOM 夹具额外设置 `MemoryHigh=48M`，回收节流使其未在 10 秒等待内触发 OOM；清理 stop 后生成正常退出记录。这次夹具调整没有算作 OOM 通过或生产缺陷。最终 OOM 夹具去掉该低阈值，使用 `MemoryHigh=infinity`，随后确认上述真实 cgroup OOM 结果。没有实施 VM 级或生产主机级 OOM 注入。

## 恢复协议收尾

- 已派发但未核实的恢复在原记录持久保存 `recovery_requires_verification=true`，再次 recover 返回 409。普通 GET、刷新和关闭重开不能解除；仅显式成功 reconcile 追加核对时间、操作者及状态后清除。核对失败仍保留门禁，核对成功但原事务仍 unknown 也不会被描述为恢复成功。
- 恢复在取得本操作生命周期锁后重新核验 worker/unit/cgroup、身份、权限代次、任务与快照，避免取锁前写 started 导致的错误阻断。只释放本次新建且仍属本操作的锁；不解除其他操作或未确认原事务的锁。
- 原程序 restore 必须先完成实际本地健康验证才写终态并解锁，平台另行 probe 后才归档。旧操作缺少审批固定目标或原快照时拒绝恢复，不猜测兼容。
- 补齐响应丢失后的后端缺口：历史 rolled_back 回执也必须执行新的独立 SSH probe；有恢复审计的 failed 同样核验原指纹、身份、运行模式、权限代次、helper、原服务状态及无锁。读取后复查账户、凭据和审批计划修订。新增 25 项回归验证有效恢复可核对归档，而指纹、服务、模式、代次、helper、生命周期锁、任务锁、身份、探测失败、账户、凭据及计划变化均拒绝归档，保留 unknown 和门禁，不重派 start/worker/commit/recover。终态保留历史 boot ID 与新的 `current_verification`。
- 恢复自身在 started 后再次中断且无可验证终态时，保留锁和证据、返回 `recovery_interrupted`。新增真实子进程测试在第一次 worker 的 cutover 被 SIGKILL 后发起恢复，在恢复实际写入 started、已恢复 current/launcher 但尚未恢复 uninstaller 时再次 SIGKILL；两次重试都拒绝重放 restore/worker，原锁与证据保留。此边界不自动重放，需要后续事实核验；没有承诺恢复动作自身能承受任意多次中断并自动完成。

## 证据位置与剩余工作

受保护的本机证据包括 `/private/tmp/lightmoni094-qa/final-systemd-budget.log`、`/private/tmp/lightmoni094-systemd-evidence/report-final.json`、对应 `README-final.md`，以及 `/private/tmp/lightmoni-vchive-retest-20261104-092/ui-094-maintenance-regression.json`。可重放的隔离 systemd 手工脚本为 `runtime/test/fixtures/maintenance-systemd-evidence.manual.mjs`；它不由普通 npm test 执行，只能在专用隔离 Linux 环境使用。没有在仓库保存 token、密码、私钥或原始受保护配置。

测试只清理自己创建的 unit、虚拟进程和残留 cgroup，保留 `/qa-recovery` 的报告、脚本和固定 runner；未修改父任务 `/qa/full` 或生产主机。真实包资源路径、真实 systemd 存活和退出证据均已有独立验证，仍不能替代最终发行在真实 Agent 上的完整管理跨版本升级、心跳确认、切换后恢复、断电/多次中断和多主机批次验收。任意业务部署、Docker daemon 变化和网络隔离场景也不属于本轮覆盖。

## 架构同步与交付

架构影响适用：仓库 `docs/system-design.md` 第94章更新维护状态机、预算、资源限制、恢复协议、持久门禁与验证边界。

Doca [LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已于 2026-11-04 经已登录编辑器保存。刷新后重新打开第94章及原生流程图，回读了五个子章节、固定资源限额、响应丢失后的持久门禁、failed/rolled_back 当前独立核验及恢复自身中断边界。原生图块 `fe6d1576-756c-424a-a2a7-da4835318921` 含14个唯一节点、16条唯一连线，准备/切换、失败/归档和不确定保锁方向已核对；原有 `sdd092-dataflow` 图块与文档首标题保留。在线版本由刷新后的正文和再次打开的图编辑器确认，未依赖本地待保存状态。截图：`/private/tmp/lightmoni-vchive-retest-20261104-092/doca094-recovery-flow.jpg`。

13:49（Asia/Shanghai）对 vchive 做最后有界只读检查：uptime 约1小时47分，load 0.04/0.07/0.01，available 1057 MiB，Agent active，helper inactive。没有再次升级或进行生产故障注入。此状态不能代证本 PR 修复已经部署。

测试用临时 VM `maintenance094`、独立 Lima 目录、`lightmoni094-budget` 容器、本次80 MB包和临时 Linux Node 已清理；保留小型报告、截图及手工夹具，未清理用户既有镜像、容器或 Colima。手工故障夹具增加 Linux/root/专用 VM 标记检查，防止误用于受管主机。

交付 PR：[95](https://github.com/workhold/lightmoni/pull/95)，目标main，本轮更新功能分支，不自行合入。仍需最终发行在真实 Agent 上进行完整升级和切换后恢复验收，本轮未发布镜像。
