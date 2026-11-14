# SDD163 验收记录

日期：2026-11-14（北京时间）。仅记录已实际完成的步骤。

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
- [发行 PR #221](https://github.com/workhold/lightmoni/pull/221) 已创建，目标为 GitHub `main`；合入尚待执行。PR 描述记录最终行为、兼容影响、相关检查、架构与 Doca 不适用理由及后续发布/生产验收门槛。
- 发行期间 `main` 新合入 #222（AI/MCP 文档及端到端检查）；发布分支已合入其 `71a5a5b6` 提交，无冲突。#222 不修改本镜像的 Runtime/Web/Agent 源码，已发布镜像的源码身份仍固定为 `eb1690bb42a47c8f5bc28df404c0d957aa9b391b`。合入后的 Compose 校验及相对最新 `main` 的差异检查再次通过。

## 固定标签镜像发布与隔离验收

- 使用 `git archive eb1690bb42a47c8f5bc28df404c0d957aa9b391b` 导出合并源码，在导出目录执行 `docker buildx build --platform linux/amd64,linux/arm64 --provenance=false --progress=plain --build-arg BUILD_REVISION=eb1690bb42a47c8f5bc28df404c0d957aa9b391b --build-arg DEBIAN_MIRROR=https://deb.debian.org/debian --build-arg DEBIAN_SECURITY_MIRROR=https://deb.debian.org/debian-security -f deploy/server/Dockerfile -t docker.heyphp.com/lightmoni/lightmoni:20261114-eb1690b --push .` 成功。固定标签清单摘要为 `sha256:14247bab78e429a80489be878c28e6e4b08e25cba596a5685b5b347fabaaedd5`。
- `docker buildx imagetools inspect docker.heyphp.com/lightmoni/lightmoni:20261114-eb1690b` 远端回读：amd64 清单 `sha256:c5b0d689e66e9fafc9e56814ffafd3e4bad4a65842928f5f8681dfc8cd70534f`，arm64 清单 `sha256:07968377fffa288cac6bff9e9a7a40ac3aff5fe6b124134cc93d787d04e3ebc5`。分别按上述平台摘要执行 `docker pull --platform linux/amd64` 和 `docker pull --platform linux/arm64` 成功；`docker image inspect` 回读平台正确，两个镜像的 `org.opencontainers.image.revision` 均为固定源码提交。
- 两个平台镜像内 `/opt/lightmoni/runtime/downloads` 的 `sha256sum -c SHA256SUMS` 与 `sha256sum -c SDK_SHA256SUMS` 均通过：两种 Agent 包和 Go、Python、Rust、TypeScript SDK 共六个归档均为 `OK`，逐一 `tar -tzf` 无错误。两种 Agent 包内 `lightmoni-agent-runtime/release.json` 的 `source_revision` 均为固定源码提交，架构分别为 amd64/arm64。
- 在本机临时 `--internal` Docker 网络内，分别按 amd64/arm64 平台摘要启动中心与独立 ClickHouse 26.8；每个平台的 `/healthz`、首页和 `/downloads/sdk/SDK_SHA256SUMS` 均返回 200，无令牌下载 Agent 返回预期的 401。检查后删除临时容器和网络，未连接或修改生产环境。
- 更新前 `latest` 索引为 `sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51`。隔离验收后执行 `docker buildx imagetools create --tag docker.heyphp.com/lightmoni/lightmoni:latest docker.heyphp.com/lightmoni/lightmoni@sha256:14247bab78e429a80489be878c28e6e4b08e25cba596a5685b5b347fabaaedd5`；再次远端回读固定标签与 `latest`，两个索引均为 `sha256:14247bab78e429a80489be878c28e6e4b08e25cba596a5685b5b347fabaaedd5`，各平台清单摘要相同。生产只使用固定标签。

## 生产切换前回读

- 1Panel 生产终端回读旧中心镜像 `docker.heyphp.com/lightmoni/lightmoni:20261113-6e9cead-agent-upgrade-v1`，容器镜像 ID `sha256:5cf5e84f3c35bdd0f9a1e21567f341235bcbec2b5c34486506880e79015a4ef3`，状态卷为 `lightmoni_lightmoni-state-v2-20261103:/data`。现场 `/opt/lightmoni/lightmoni/compose.yaml` 的中心镜像仍为同一旧固定标签；`docker compose config --quiet` 通过。该部署目录不是 Git 工作树，需按已合入的发行配置精确更新现场镜像行。
- 上一聊天已在 root 私有目录 `/root/lightmoni-release-20261114-eb1690b` 留存原 `.env`、Compose、主密钥、容器 inspect 和 SQLite 在线备份；本次回读目录权限 0700，五个备份文件均为 0600。SQLite 备份大小 3333783552 字节，上一聊天执行的 `quick_check` 为 `ok`。未回读任何凭据内容。

## 待执行的生产部署与线上回归

发行 PR 合入、GitHub Release、仅中心重建、Agent 可升级性以及线上只读验收仍待执行。固定标签隔离验收不代表生产已上线。

## 架构判断

本发行架构影响不适用，理由见 [规格](spec.md)；仓库 `docs/system-design.md` 无需新章节，Doca 同步也不适用。#185 与 #220 的仓库设计、历史 Doca 同步与最新版本回读记录分别见 SDD134/162；本发行不声称新的 Doca 写入。
