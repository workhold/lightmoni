# SDD172 验收记录

日期：2026-11-15。仅记录已实际完成的步骤。

- [PR #226](https://github.com/workhold/lightmoni/pull/226) 已合入，合并提交 `93dbe07001f3f37ec0d249705adce6619a67f3e7`，修正应用中心最新状态模型的测试样本和期望；相关 4 项通过，Runtime 类型检查通过。
- [PR #218](https://github.com/workhold/lightmoni/pull/218) 已合入，合并提交 `5c3cbaec07c44dde99a6571b3075e74536c3b31f`；[PR #219](https://github.com/workhold/lightmoni/pull/219) 已合入，合并提交 `4ce37ce4e2e9c0e6114b3ab7a8088671b5ed46ec`。合入时 GitHub 无其他开放 PR。期间 #227–#231 已在前序主干合入，此次镜像源码将包含这些变更。
- #218 的构建、类型检查和定向 Runtime 78/79（1 项跳过）、AI 79/79、SDK 28/28 通过；完整 Runtime 的 7 项失败均可在同期纯主干复现。#219 整合 #231 后定向 Runtime 89/89、AI 84/84、Web 10/10、三处构建和类型检查均通过；此前完整 Runtime 的 39 项失败均可在同期纯主干复现。最终源码版本一致性 `npm run version:check` 为 46 项通过。
- #218 架构同步见 [SDD167 验证](../167-service-principal-capability-automation/validation.md)，Doca 保存并回读至 seq1814/version1816；#219 见 [SDD171 验证](../171-service-task-proposal-automation/validation.md)，最终 Doca 改号后保存并回读至 seq1817/version1819。两者的仓库正文与 Doca 目标块逐字一致，原生图保持。
- 本发行分支已合并 `origin/main@4ce37ce4e2e9c0e6114b3ab7a8088671b5ed46ec`，仅将根 Compose 中心镜像引用从 `v0.1.1-20261115-073239-amd64` 改为 `v0.1.1-20261115-100500-amd64`，未更改 ClickHouse、卷、环境、端口或健康检查。
- 从固定源码提交 `4ce37ce4e2e9c0e6114b3ab7a8088671b5ed46ec` 的干净归档构建并推送 Linux amd64 中心镜像 `docker.heyphp.com/lightmoni/lightmoni:v0.1.1-20261115-100500-amd64`。远端回读固定标签的摘要为 `sha256:e27ebcda6afeab49315d494954d6c654dbc40f726f38a411892bf88eb7c54fd3`；隔离验收后推送并回读 `latest`，摘要相同，旧固定标签保留。镜像 OCI revision 与源码提交一致；版本一致性检查 46/46 通过。
- 对镜像内 `lightmoni-agent_0.1.1_linux_amd64.tar.gz`、`lightmoni-agent_0.1.1_linux_arm64.tar.gz` 和四种 SDK 归档执行 SHA256 清单核验，均通过；两个 Agent release 元数据的 `source_revision` 均为上述源码提交。隔离 ClickHouse + 中心启动成功：`/healthz` 和首页均为 200，实例版本及 MCP `serverInfo.version` 均为 `0.1.1`；未认证的实例设置、Agent 下载和 MCP 入口为 401，设置初始化后带会话的实例设置与 MCP access 为 200。该隔离环境不使用生产凭据或数据。
- 架构影响判断：本发行不适用，理由见 [规格](spec.md)；#218/#219 的架构同步结果记录在各自 SDD 和 PR 中。SDD169 的版本规范现要求 0.1.1 的 amd64 固定标签。

待记录：发行 PR/Release、生产备份/切换及线上回归。

## 发行交付与生产处置（2026-11-15）

- 发行 PR #232 已合入 main，SDD091 历史证据补录 PR #233 已合入；GitHub Release `20261115-4ce37ce` 指向源码提交 `4ce37ce4` 并附发行回执附件。固定标签与 `latest` 的远端摘要经独立 `docker buildx imagetools inspect` 回读一致，镜像 OCI revision 与源码提交一致。
- 生产中心（1Panel Compose 项目）已切换到 `v0.1.1-20261115-100500-amd64`，`/healthz` 200、实例版本 0.1.1。切换后复核发现根 Compose 仍固定旧标签（配置漂移），已修正为 v0.1.1 固定标签并保留原文件备份；旧标签远端摘要确认未被污染，回滚路径完整。切换后补做一致性备份：SQLite `VACUUM INTO` 快照（约 3.2GB，integrity ok）与 compose、主密钥副本同存于服务器受保护目录。
- 线上只读验收通过：`/api/v1/*`、`/api/v1/mcp`、Agent 下载未认证均 401；系统日志与主机指标持续入库（分钟级新鲜）；`/api/v1/capabilities` 正常返回能力描述符。未为测试创建生产应用动作、任务提案或服务主体调用。
- 生产主机 zz-bj-1 复核发现：11-14 01:26 一次受管 job 因 Agent 租约过期形成 unknown 围栏，四个应用实例的平台观察停摆约 37 小时（实例 healthy=false、applied=0），宿主容器实际全部运行。经人工核对释放该 job（`privileged-execution/jobs/:id/reconcile`），主机内存 busy 标志出现泄漏、以重启中心清除后，Agent 经标准 `agent-updates/start` 流程升级至 0.1.1（一次成功，含健康确认与自动回退保障）。恢复循环随后自动完成四个应用对账：全部 healthy、applied 与 desired 一致（9/9、7/7、3/3、7/7）。过程未修改应用配置或数据。
- 生产主机 zsw-hk8c8g-3xui-1 的 11-13 升级残留记录为 `rollback_failed`→unknown：只读核对通过但记录无法终态化（recover 要求现场与计划快照一致，而现场 helper activation 已变化），且阻断新维护计划。经管理员裁定以 cancelled 收尾（附审计事件）；现场 Agent 0.1.0 健康运行。其新升级因 Agent 侧维护残留（疑似操作锁）预检被拒，待主机现场核查后另行升级。
- 遗留：zsw-bj-1 已在 0.1.1 旧构建，可择机升级到固定构建；vchive 主机 11-11 起离线、升级记录挂起，待确认机器现状后处理。
- 待改进项（另行 SDD 承载）：(1) `rollback_failed` 的 unknown 维护无法终态化形成死局：cancel 仅接受 awaiting_approval、recover 严格要求现场与快照一致、旧记录阻断新计划；(2) 主机 busy 标志为内存 Set，无持有者、TTL 与观测手段，泄漏时只能重启中心；(3) 维护类 409 文案未附带处理入口（哪个 job/哪条记录、去哪核对）；(4) 实例观察停摆缺少主动检测与告警。
