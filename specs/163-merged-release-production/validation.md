# SDD163 验收记录

日期：2026-11-14 至 15 日（北京时间）。仅记录已实际完成的步骤。

## 功能合入与集成检查

- [PR #185](https://github.com/workhold/lightmoni/pull/185) 已合入，合并提交 `cf9cac219db3b27b708f265de7903cbbe56346fb`。
- [PR #217](https://github.com/workhold/lightmoni/pull/217) 已合入，合并提交 `d35fa35d1b42033190598741bd58647092c02030`。
- [PR #220](https://github.com/workhold/lightmoni/pull/220) 已合入，合并提交 `eb1690bb42a47c8f5bc28df404c0d957aa9b391b`。#185 与 #217 的应用页重叠已在各后续分支合并中处理；最终合并树与隔离集成演练一致。
- 合并树 Runtime 类型检查通过；相关 Runtime 4 个文件 143 通过、1 个真实容器环境用例跳过。Web 构建与状态模型 11 项通过；慢响应、应用状态与核对浏览器回归通过。Agent 更新浏览器检查 13 项、任务中心 18 项、告警响应 8 项通过。告警检查首次未启动测试 Vite 服务而失败，启动本地服务后重跑通过；无生产写入。

## 发行配置 PR

- 根 `compose.yaml` 的中心镜像从 `20261113-6e9cead-agent-upgrade-v1` 更新为固定标签 `20261114-eb1690b`；ClickHouse、端口、环境、卷、健康检查及构建参数未改。
- 发布分支基于已合入三个功能 PR 的 `origin/main` 提交 `eb1690bb42a47c8f5bc28df404c0d957aa9b391b`，发布配置提交与镜像源码提交分开。
- `LIGHTMONI_CH_PASSWORD=placeholder docker compose config --quiet` 通过；`docker compose config --images` 回读中心为 `docker.heyphp.com/lightmoni/lightmoni:20261114-eb1690b`、ClickHouse 为 `clickhouse/clickhouse-server:26.8`。占位值仅作为本地校验进程的环境变量，未写入文件。
- 暂存差异执行 `git diff --cached --check` 通过；变更仅含根 Compose 的中心镜像引用与 SDD163 五个文件。
- [发行 PR #221](https://github.com/workhold/lightmoni/pull/221) 已合入 GitHub `main`，合并提交 `1193ee1862f3cd3a9a0fa8db72b5b392649846c5`。PR 描述记录最终行为、兼容影响、相关检查、架构不适用理由及后续发布/生产验收门槛。
- 发行期间 `main` 新合入 #222（AI/MCP 文档及端到端检查）；发布分支已合入其 `71a5a5b6` 提交，无冲突。#222 不修改本镜像的 Runtime/Web/Agent 源码，已发布镜像的源码身份仍固定为 `eb1690bb42a47c8f5bc28df404c0d957aa9b391b`。合入后的 Compose 校验及相对最新 `main` 的差异检查再次通过。

## GitHub Release 回读

- [Release `20261114-eb1690b`](https://github.com/workhold/lightmoni/releases/tag/20261114-eb1690b) 已发布；GitHub 回读为非草稿，`targetCommitish` 是镜像构建源码提交 `eb1690bb42a47c8f5bc28df404c0d957aa9b391b`，与发行配置 PR 的合并提交分开。

## 固定标签镜像发布与隔离验收

- 使用 `git archive eb1690bb42a47c8f5bc28df404c0d957aa9b391b` 导出合并源码，在导出目录执行 `docker buildx build --platform linux/amd64,linux/arm64 --provenance=false --progress=plain --build-arg BUILD_REVISION=eb1690bb42a47c8f5bc28df404c0d957aa9b391b --build-arg DEBIAN_MIRROR=https://deb.debian.org/debian --build-arg DEBIAN_SECURITY_MIRROR=https://deb.debian.org/debian-security -f deploy/server/Dockerfile -t docker.heyphp.com/lightmoni/lightmoni:20261114-eb1690b --push .` 成功。固定标签清单摘要为 `sha256:14247bab78e429a80489be878c28e6e4b08e25cba596a5685b5b347fabaaedd5`。
- `docker buildx imagetools inspect docker.heyphp.com/lightmoni/lightmoni:20261114-eb1690b` 远端回读：amd64 清单 `sha256:c5b0d689e66e9fafc9e56814ffafd3e4bad4a65842928f5f8681dfc8cd70534f`，arm64 清单 `sha256:07968377fffa288cac6bff9e9a7a40ac3aff5fe6b124134cc93d787d04e3ebc5`。分别按上述平台摘要执行 `docker pull --platform linux/amd64` 和 `docker pull --platform linux/arm64` 成功；`docker image inspect` 回读平台正确，两个镜像的 `org.opencontainers.image.revision` 均为固定源码提交。
- 两个平台镜像内 `/opt/lightmoni/runtime/downloads` 的 `sha256sum -c SHA256SUMS` 与 `sha256sum -c SDK_SHA256SUMS` 均通过：两种 Agent 包和 Go、Python、Rust、TypeScript SDK 共六个归档均为 `OK`，逐一 `tar -tzf` 无错误。两种 Agent 包内 `lightmoni-agent-runtime/release.json` 的 `source_revision` 均为固定源码提交，架构分别为 amd64/arm64。
- 在本机临时 `--internal` Docker 网络内，分别按 amd64/arm64 平台摘要启动中心与独立 ClickHouse 26.8；每个平台的 `/healthz`、首页和 `/downloads/sdk/SDK_SHA256SUMS` 均返回 200，无令牌下载 Agent 返回预期的 401。检查后删除临时容器和网络，未连接或修改生产环境。
- 更新前 `latest` 索引为 `sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51`。隔离验收后执行 `docker buildx imagetools create --tag docker.heyphp.com/lightmoni/lightmoni:latest docker.heyphp.com/lightmoni/lightmoni@sha256:14247bab78e429a80489be878c28e6e4b08e25cba596a5685b5b347fabaaedd5`；再次远端回读固定标签与 `latest`，两个索引均为 `sha256:14247bab78e429a80489be878c28e6e4b08e25cba596a5685b5b347fabaaedd5`，各平台清单摘要相同。生产只使用固定标签。

## 生产切换前回读

- 1Panel 生产终端回读旧中心镜像 `docker.heyphp.com/lightmoni/lightmoni:20261113-6e9cead-agent-upgrade-v1`，容器镜像 ID `sha256:5cf5e84f3c35bdd0f9a1e21567f341235bcbec2b5c34486506880e79015a4ef3`，状态卷为 `lightmoni_lightmoni-state-v2-20261103:/data`。现场 `/opt/lightmoni/lightmoni/compose.yaml` 的中心镜像仍为同一旧固定标签；`docker compose config --quiet` 通过。该部署目录不是 Git 工作树，后续按已合入的发行配置精确更新现场镜像行。
- 上一聊天已在 root 私有目录 `/root/lightmoni-release-20261114-eb1690b` 留存原 `.env`、Compose、主密钥、容器 inspect 和 SQLite 在线备份；本次回读目录权限 0700，备份工件权限为 0600。SQLite 备份大小 3333783552 字节，上一聊天执行的 `quick_check` 为 `ok`。未回读任何凭据内容。
- ClickHouse `lightmoni` 数据库已通过 `BACKUP DATABASE` 创建在线备份，返回 `BACKUP_CREATED`；归档已复制为私有目录内的 `lightmoni-telemetry-pre-release.zip`，权限 0600，大小 512174853 字节，SHA256 为 `a80491f703ed9e1d8e57ee88e9c5127145a87f8dd1df3399d357872b1db84aeb`。
- 生产主机已拉取 `docker.heyphp.com/lightmoni/lightmoni:20261114-eb1690b`；远端摘要为 `sha256:14247bab78e429a80489be878c28e6e4b08e25cba596a5685b5b347fabaaedd5`，拉取后的 amd64 镜像 revision 为 `eb1690bb42a47c8f5bc28df404c0d957aa9b391b`。切换前现场中心仍运行旧固定标签。

## 生产中心部署与回读

- 现场 `/opt/lightmoni/lightmoni/compose.yaml` 与备份相比只改变中心镜像一行，从 `20261113-6e9cead-agent-upgrade-v1` 改为 `20261114-eb1690b`；`docker compose config --quiet` 通过。执行 `docker compose up -d --no-build --no-deps --pull never --wait lightmoni`，仅重建中心服务并等待健康状态，结果为 Healthy。
- 新中心实际镜像标签为 `20261114-eb1690b`，`org.opencontainers.image.revision` 为 `eb1690bb42a47c8f5bc28df404c0d957aa9b391b`，状态卷仍为 `lightmoni_lightmoni-state-v2-20261103:/data`。ClickHouse 容器 ID 仍为 `428c2c268b044d79cd81ccac3f6269d8cae3531d65bfb0bafd8e78cdd1e45747`，状态 Healthy；本地与公开地址的 `/healthz` 均返回 200。回滚版本为部署前固定镜像 `20261113-6e9cead-agent-upgrade-v1`，其现场 Compose 和状态数据备份已留存。

## 线上应用中心只读核对

- 浏览器强制刷新后，应用中心共显示 4 个资源：3 个“待核实”、1 个“结果未知”，未显示“待处理”；使用“待核实”筛选后显示 3 个资源。
- OpenResty 卡片与实际详情均为“待核实”；期望版本为 v7、已应用版本为 v0。“升级”“停止”“卸载”“删除”处于禁用状态。“核对状态”进入安装进度，显示“运行状态待核实”，重新部署按钮禁用；已选择只读检查运行记录。
- PostgreSQL 原始执行保持“结果未知”：只读检查关联运行 `49476454264b7ff84af30faf60e74771`、主机任务 `2cd6ec416bf0cfc987f3d0ef7e6d9e14`，错误码为 `execution_unknown`。此次核对未触发重试，未改写原始执行结果。
- 这些页面回读证明新中心已提供受限状态与核对入口；PostgreSQL 原始未知执行已单独核对。应用中心完成加载与状态筛选，但本次未量化加载耗时。

## Agent 升级回读

- 2026-11-15 08:25:04（北京时间），线上 UI 显示主机 `zsw-hk8c16g-doca-1` 的 amd64 Agent 从 `cd1e60963798` 升级到 `eb1690bb42a4`，操作 ID 为 `b3c51414a87e9682127dac2ae522c399`。
- `zsw-bj-1` 的 amd64 Agent 从 `6e9ceadd8441` 升级到 `eb1690bb42a4`；执行阶段时间为 2026-11-15 08:29:08（北京时间），操作 ID 为 `1cba211acb90f4234a60c95ee303d34e`，目标包 SHA256 为 `62f429b742889fd379a81ef0c4d2de38dc5067a6036cfb549d9714a8b2461763`。
- 两台升级成功的主机在关闭操作弹窗后，页面均回读为“在线”“完整管理”“当前发行”，且显示新的心跳。
- `zz-bj-1` 页面显示“部分操作暂不可用”，原因是“节点有运行中、已派发或结果未知的任务，请先完成或核对”；其 Agent 保持 `6e9ceadd8441`，未升级，保留任务围栏。
- `zsw-hk8c8g-3xui-1` 在线，但历史升级仍为“更新中/结果未知”；`vchive` 离线，历史升级同样为“更新中/结果未知”。两台均未重复升级，保留原任务状态等待核对。

## 工作台与首页只读回读

- 管理员 `admin` 登录态有效；默认 `/assistant` 页面完整加载，显示“AI 助手”标题、历史会话和输入界面。
- `/overview` 页面完整加载，显示 16 个数据表、5 个执行节点、2 个启用 Key、1 个团队成员；接入数据表列表可读。线上主机心跳与上述两台 Agent 升级后的新心跳已回读。
- 本次确认固定镜像发布、生产中心健康与页面行为。历史“结果未知”的应用执行没有因此恢复为确定状态；被任务围栏保护或历史升级未知的 Agent 也没有强制重试或升级，仍需管理员按现有流程核对。

## 架构判断

本发行架构影响不适用，理由见 [规格](spec.md)；仓库 `docs/system-design.md` 无需新章节，Doca 同步也不适用。#185 与 #220 的仓库设计、历史 Doca 同步与最新版本回读记录分别见 SDD134/162；本发行不声称新的 Doca 写入。
