# Agent 能力验收记录

日期：2026-11-01（Asia/Shanghai）。基线：`3720a5085f9fffe363e90908bbd15976a741b6ee`。真实主机原始证据仅保留本机临时目录，不向公开仓库提交 IP、身份、凭据或系统日志。

实机使用平台现有发行；本 PR 的指纹与采集补丁完成本地隔离验证，尚未发布镜像或部署到平台/Agent。不能把基线实机通过等同于补丁已经在线。

## 实机结果

| 能力 | 验收结果与边界 |
| --- | --- |
| 主机身份 | 平台自定义名称、平台主机 ID、系统 hostname、Agent ID 和遥测 host_id 正确分离 |
| CPU / 内存 / 系统 | CPU 比例、内存总量/可用量/使用量、Swap、load、运行时长均有新鲜入库样本；内存总量与 OS 一致 |
| 文件系统 | 根分区容量与 OS `statfs` 一致；按 mountpoint 独立记录，不能把多个挂载点简单相加 |
| 磁盘 / 网络 I/O | 增量 Counter 实际入库，单位为字节；包括磁盘分区、loop、bridge、veth 和 loopback，不能当作所有设备总和或直接的字节/秒 |
| 主机与网络发现 | 与 OS 网卡快照一致；默认路由网卡的内网地址、Docker 桥和链路本地地址含义不同；平台连接来源 IP 不证明公网入口或完整出口 |
| 有界脚本任务 | 从任务中心创建、按 revision 派发，Agent 专用账户执行成功，stdout、退出码和执行记录回传；OS、CPU、网卡、内存总量、文件 stat 与 SSH 基准一致；临时任务定义已删除，历史保留 |
| 密码 SSH | 平台保存的密码完成预检和一次标准卸载；另有两次 SSH 预检失败，均未进入远端删除阶段，原因不能仅凭通用错误确定。后续恢复安装使用已授权私钥 |
| 标准卸载 | 实机完成服务停止、程序移除、配置/身份/缓存保留；只撤销该 Agent 的 control/data 两项凭据，保留主机资产 |
| 重装保护 | 仅标准卸载后，程序虽已不存在，保留配置仍阻止 fresh 安装，返回 409，符合预期 |
| 离线脚本 | 从平台取得脚本并核验 SHA256，`--purge` 实机清除标准卸载留下的固定配置/身份/缓存；不声称该本地脚本会撤销平台凭据 |
| SSH 恢复卸载 | 同一授权测试主机本轮接入前已通过平台执行恢复清理及 purge；该旧身份没有本平台独立凭据，回执明确不撤销。此前结果不替代本次标准卸载验收 |
| 更新 / 回退拒绝 | 实机相同摘要升级返回 409；没有可验证上一发行时回退返回 409。平台只有一个当前发行，未伪造发行或声称完成真实跨发行升级/回退 |
| 更新 / 回退执行器 | 隔离夹具以生产 SSH 探测源码计算指纹，再进入真实维护器升级及主动回退；覆盖确认、失败恢复、身份/配置/队列保留和 helper 一致性 |
| 最终重装 | 平台安装状态 succeeded、收到新 Agent 激活回执；平台主机 ID/自定义名称保持不变，新 Agent 在线且配置 revision 一致，CPU/内存/运行时长的新身份数据已重新入库。所有基础采集状态为 ok，Docker unavailable 限制仍保留 |

## 修复

- 平台探测遗漏 release 内的卸载脚本摘要，导致与远端维护器不一致：已对齐；没有 helper 时保留原摘要，有 helper 时绑定内容，符号链接仍拒绝。
- 远端已有的 `uninstaller_updated` 回执被平台丢弃：保留可选布尔值，包含 `false`，测试 HTTP 回读和 SQLite 持久化。
- 多个进程匹配器只统计首个规则：各规则独立统计并保留独立 CPU 增量基线。
- 无权读取进程 FD 时仍报告完整 `ok`：保留可读测量，不伪造 0，使用既有 `partial` 状态，权限恢复后回到 `ok`。

## 未修复缺口及配置限制

以下项目不能标为当前主机“全部能力可用”：

- Docker：真实 Agent 服务用户访问 Docker socket 被拒绝，root SSH 可访问；应用采集状态正确显示 unavailable。未授予 Docker 组、root 或额外提权。
- systemd 发布、网站、证书、备份和 Compose：已有有界执行器与测试，但依赖对应软件、受控目录、服务操作权限和精确 `ReadWritePaths`。默认安装不自动满足这些前置条件，未在业务服务上做破坏性测试。
- 能力广告：目前主要表示协议实现支持，不能替代每台主机的依赖及权限就绪检查。
- AI 诊断：任务中心保存脚本 stdout/stderr，但现有 AI `get_task_run` 只返回元数据，不能声称 AI 已能读取任意脚本结果；现有结构化 node.inspect 字段有限。
- 服务拨测、目录日志：未配置目标/路径时是待配置；不代表采集故障。本次未为测试添加真实业务目标。
- 规模边界：磁盘前 32 条可能被 loop 等设备占满；Docker 清单前 500 个可能遗漏受管目标，单组 stats 失败可能影响其他组和日志。
- 运维执行：platform Docker 调用未统一固定本机 context；原始 Compose 通道的权限范围比受限 Compose 域宽；部署/运维 runner 的在途操作尚未连接 Agent 父停止信号。以上需后续独立修复，不能误报为本 PR 已解决。

## 隔离测试

- 更新维护器与 HTTP：65 项通过；生产 SSH 探测与远端维护器跨实现一致性、主动回退、helper 内容变化、符号链接拒绝、布尔回执持久化均覆盖。
- Agent 与进程采集：16 项通过，包含新增 5 项重叠匹配、独立上限、FD 权限失败/恢复、名称不可读及非 Linux CPU 增量回归。
- 任务、部署、运维执行：119 项，106 通过、13 因本机不是 Linux/root 跳过、0 失败；Docker/Nginx/Certbot 使用注入夹具，不冒充实机功能通过。
- runtime 类型检查与 `git diff --check` 通过。

运行命令（工作目录 `runtime/`，各组文件无重叠）：

```sh
node --import tsx --test --test-concurrency=1 test/agent-update-runner.test.ts test/machine-agent-updates.test.ts
node --import tsx --test --test-concurrency=1 test/agent.test.ts test/agent-collect.test.ts
node --import tsx --test --test-concurrency=1 test/agent-executor.test.ts test/operations-executor.test.ts test/agent-job-runner.test.ts test/agent-jobs.test.ts test/task-center.test.ts test/task-script-options.test.ts test/task-schedules.test.ts
node --import tsx --test --test-concurrency=1 test/platform-executor.test.ts test/operations-containers.test.ts test/operations-websites.test.ts test/operations-certificates.test.ts test/operations-backups.test.ts
npm run typecheck
```

合计 200 项独立用例：187 通过、13 跳过、0 失败。早期缺少本地依赖而未进入测试的运行不计入；依赖已在本机安装，未在远端构建。

架构影响：不适用。实现纠错保持已有职责、协议、凭据边界及部署拓扑；未改写仓库系统架构或 Doca。
