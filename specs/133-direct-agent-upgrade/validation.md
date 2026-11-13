# SDD 133 验收记录

## 行为与兼容

- 管理员点击单机“升级 Agent”后只提交一次 `POST .../agent-updates/start`。服务端使用登记的默认 SSH 凭据和只读远端探测架构，选择该架构最新的已验证发行；内部计划固定摘要与主机现场并立即执行。回退、批次及旧计划链接仍走原审批协议。
- `queued` 且无领取、开始或尝试证据的任务保留队列并等待维护结束；已领取、运行中或 unknown 工作继续阻断维护。生产 `zz-bj-1` 的旧 unknown 任务和后续自动状态核对均已通过任务账本及界面核对，详情见下文。
- 阶段事件独立持久化，按操作 ID 回读。每次操作最多保留最近 100 条固定阶段与时间，不含 SSH 原始输出或秘密；平台重启时未确认操作标记 unknown 并追加事件。

## 本地验证

- `npm --prefix runtime run typecheck`、`npm --prefix web run typecheck`：通过。
- `node --import tsx --test test/machine-maintenance.test.ts test/machine-agent-updates.test.ts`：89/89 通过，覆盖自动架构目标、单次启动、排队脚本延期、任务领取围栏、旧回退/批次及重启 unknown。
- `node scripts/test-agent-update-direct-ui.mjs`：6/6 浏览器检查通过，覆盖一次提交、无发行/计划表单、阶段日志、失效默认凭据及异步主机切换。
- `npm --prefix web run build`、`git diff --check`：通过。
- 浏览器为本地构建与 API fixture；运行时测试为模拟 SSH。没有据此声称生产主机已完成 Agent 升级。

## 架构同步

- 架构影响：有。新增管理员单次升级控制路径、维护队列判定和持久阶段事件；凭据边界、固定维护器及成功证明保持原协议。
- 仓库章节：`docs/system-design.md` 第 28.1、28.2、28.4、28.6 节；使用文档 `docs/agent-deployment.md` 和 `README.md` 已更新。
- Doca：[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 的 Agent 版本、升级与回退章节，编辑回执 `saved: true`，seq 1800。最新版本回读 `agent044-p-2`、`agent044-p-11`、`agent044-p-19` 与原生 `agent044-maintenance-flow` 均与目标一致；流程图 14 个节点和 14 条连线逐项一致，无关块未修改。

## 发布与生产

功能由 [PR #183](https://github.com/workhold/lightmoni/pull/183) 合入 GitHub `main`，合并提交 `6e9ceadd8441dc810219cc70490aa1394e02e781`。

固定镜像 `docker.heyphp.com/lightmoni/lightmoni:20261113-6e9cead-agent-upgrade-v1` 已从该提交构建并推送。远端多架构索引为 `sha256:5cf5e84f3c35bdd0f9d1e21567f341235bcbec2b5c34486506880e79a15a4ef3`，包含 amd64 清单 `sha256:2ca01ed64d5b5465b85480d8c39bdf4f38c153741794901350402bf19ce80dfe` 和 arm64 清单 `sha256:70cf53df7a8a2f686bc1c51c48ababcda5fe0df4e8b775f081466ef7d6963d8c`。两平台容器内的双架构 Agent 发行清单均指向该完整源码修订，OCI revision 相同；见 [镜像证据](evidence/release-image.json)。

发行 PR [#184](https://github.com/workhold/lightmoni/pull/184) 已合入 GitHub `main`，合并提交 `65ebc79`。根 Compose 中心镜像固定为上述标签。

2026-11-13 在中心主机停服后冷备状态库至 `/root/lightmoni-133-20261113-UTF8gw/lightmoni-pre-agent-upgrade.db`，源和副本均为 3,190,820,864 字节；副本可由 SQLite 打开且 `schema_version=263`。部署配置亦单独备份；不在证据中记录环境文件内容或凭据。

生产中心执行 `docker compose config` 校验后，只重建 `lightmoni` 服务。容器回读为 `healthy` 且镜像标签一致，ClickHouse 保持健康；公网主机列表可访问，Agent 有新鲜心跳。

目标主机 `zz-bj-1` 的旧 `inspect` 提权记录原结果为 unknown。核对目标容器仍运行后，通过应用界面标记“结果未知，已人工核对”，保留原结果和审计理由，解除旧互斥；未重放应用动作。随后单机升级首次点击被并发 SSH 占用拦截，平台未创建新的 `machine_agent_updates` 记录。中心任务账本确认，该主机的 OpenResty、PostgreSQL 自动状态核对约每分钟触发“受管主机运维”提权任务，单次约占用 SSH 通道 45–55 秒。它由 `deployment.instance` 协调器生成，不是外部验收脚本。

为取得单机维护窗口，2026-11-14 00:42 左右仅将该主机 7 条 `deployment.instance` 协调资源的 `next_attempt_at` 延后 20 分钟，未改动工作负载状态或动作结果。延后时间为 01:02:08（北京时间）；01:25 主机界面再次显示终端受占用和“部分操作暂不可用”，表明自动核对已恢复。维护窗口内点击“升级 Agent”通过了 SSH 占用门禁，但远端探针返回 `unmanaged_installation`，界面显示“当前 Agent 安装未通过受管指纹、账户或状态检查”；仍未创建新的升级记录，目标 Agent 仍为 `0.1.0`、修订 `16b151337cc9`。

经目标机只读核对，当前和上版的发行元数据、安装记录、root 所有权、systemd 单元摘要、helper 状态及快照文件表面一致，尚未定位具体拒绝项。目标机临时 SSH 终端已断开。**生产 Agent 升级未完成**；不能将中心部署成功或入口能点击视为目标升级成功。

本次后续 PR 仅补充生产验收事实，不修改组件职责、数据或控制路径、凭据边界、存储、协议、部署拓扑或 AI 与工具边界。架构同步：不适用；原架构变更及 Doca 回读已在 #183 完成。
