# Agent 升级与回退验收

2026-10-30，在本机与本机隔离 Linux 环境完成验收。当前交付包括固定发行目录、单机升级/主动回退、持久串行批次、失败自动恢复、只读核对、主机维护互斥，以及中英文界面和 AI 查询/提案工具。尚未发布镜像，也未连接或修改生产主机、vchive。

## 自动回归与构建

以下命令在仓库根目录执行；针对测试文件的命令在 `runtime/` 执行。

| 检查 | 结果与范围 |
| --- | --- |
| `npm --prefix runtime test` | 550 项测试，533 通过、17 跳过、0 失败；最终日志为本地 `.local-dev/agent-updates-runtime-final.log` |
| `node --import tsx --test --test-concurrency=1 test/agent-update-runner.test.ts test/assistant-agent-updates.test.ts test/machine-agent-updates.test.ts` | 46/46 通过：维护器 19、AI 2、中心 API 25；见 [API 验收](api-validation.md) 和 [维护器验收](systemd-validation.md) |
| `test/install-release.test.ts` | 14/14 首装回归通过，包含失败恢复及配置/身份/队列权限保持；亦在完整回归中执行 |
| `npm --prefix runtime run typecheck`、`npm --prefix runtime run build` | 通过 |
| `npm --prefix web run build` | 类型检查及生产构建通过 |
| `node scripts/test-agent-update-ui.mjs` | 生产 bundle 的 13 组浏览器交互通过，无预期外请求或页面错误；见 [UI 报告](ui-report.json) |

完整回归中的 17 项跳过主要依赖 Linux 运行环境、发行物或外部 ClickHouse/平台配置；不能把跳过项计为通过。新增升级中心 API 使用真实 SQLite、HTTP 路由和加密凭据，并注入可控 SSH 结果覆盖故障；它与下面的真实 systemd 验收分开解释。

中心 API 覆盖目标摘要固定、缓存篡改拒绝、审批期限/重放、精确新启动健康门槛、响应丢失后核对、服务停止后的主动回退、任务互斥和持久批次。特别补充两类恢复：已提交后 Agent 再次自然重启仍可独立核对当前健康；回退来源原本停止且本次回退失败时，确认恢复原程序与原停止状态，不永久遗留 unknown。审批后服务状态变化由中心及远端维护器再次拒绝；明确未切换的失败允许原服务停止，核对后记录 failed。恢复失败或证据不完整仍保留 unknown 和维护阻塞。

UI 验收涵盖单机审批、主动回退、unknown 核对、AI 深链、批次审批所有权、暂停/继续/取消、成员只读、中英文窄屏，以及状态刷新失败后不误报、不自动重试。界面使用 API fixture；它不代表真实 SSH 执行。

## 真实 Linux/systemd

在本机 Colima 的独立 Debian 12 / arm64 / systemd 252 容器，使用真实 bundled Node 24.15.0 和非 root Agent 服务完成 9 组验收：旧 0.1.0 升级、同版本不同 build 升级、主动回退、启动失败自动恢复、确认超时自动恢复、恢复旧 0.1.0，两项非空 pending 队列跨成功/失败恢复保留，以及审批后双向运行状态变化拒绝。

成功案例先收到真实目标发行的新 boot、包摘要/build 和已应用配置心跳，再发送 commit 并读到持久 succeeded。非空队列案例比较真实 HTTP `/v1/logs` 接收的非空待上报 payload 集合摘要（最终复验为 1 批），并核对配置和身份摘要；不要求动态 SQLite 文件字节或重试计数完全相同。

详细环境、逐项结果和限制见 [真实 systemd 验收说明](systemd-validation.md) 与 [原始结果](systemd-report.json)。临时容器已移除，并停止本轮使用的 Colima profile。

双架构包均已构建，并校验官方 Node 摘要及 ELF 架构；只有 arm64 完成了真实 systemd 升级/回退。隔离中心为接收真实 Agent 注册、心跳和配置的 HTTP fixture，未测试生产网络或生产审批端到端链路。

## 本地平台与设计同步

本地平台在 `http://127.0.0.1:18080/machines` 启动，使用真实 HTTP、SQLite 和本地 ClickHouse；已登录主机页、查看新增 Agent 发行列、读取真实 amd64/arm64 发行目录并打开升级批次历史弹窗。主机均为隔离演示记录，无真实 SSH 操作，见 [本地运行报告](local-runtime.json)。

仓库系统设计第 28.1–28.7 节、部署文档和 README 已更新。[Doca 在线设计](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已同步并回读至 seq 803：保留原 17 幅原生图和 418 个无关顶层块，更新 3 段并核对 27 个新增块；新增维护控制流图 14 节点/14 连线、状态图 8 节点/11 连线，回读节点与连线匹配。见 [同步证据](doca-sync.json)。未完成在线视觉渲染验收，不据此声称图的视觉排版已经验收。

## 交付边界

- 仅支持相同 `state_schema=1` 的受管 Linux/systemd 安装；未知程序或 schema 拒绝自动操作。旧受管 0.1.0 可作为升级源和失败恢复目标，主动回退目标必须有完整发行/新启动协议。
- Agent 自身维护需要 root 或免交互 sudo 的 SSH 通道。普通 Agent 继续非 root 运行，不通过升级功能获得长期提权能力。
- 掉电、强杀或 systemd 派发结果不确定时保留回执和 unknown；核对只读，不自动重放、不补发 commit，也不自动清锁。人工恢复步骤见 [API 验收](api-validation.md#人工恢复边界)。
- 本轮没有发布镜像、更新生产或操作 vchive，amd64 真实升级/回退仍待独立验收。
- 任务中心作为界面、AI 与外部客户端统一提交/记录入口的方向已写入系统设计；统一外部 API、服务身份/scope 和 typed action 注册表尚未实现，应另起 SDD。
