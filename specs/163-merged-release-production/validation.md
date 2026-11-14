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

## 镜像发布、生产部署与线上回归

待执行并逐项记录固定标签及 `latest` 的远端摘要、双架构回拉、GitHub Release、生产原镜像和卷身份、受保护备份、仅中心重建、Agent 可升级性以及线上只读验收。合入和本地回归、Compose 配置校验均不代表镜像已发布或生产已上线。

## 架构判断

本发行架构影响不适用，理由见 [规格](spec.md)；仓库 `docs/system-design.md` 无需新章节，Doca 同步也不适用。#185 与 #220 的仓库设计、历史 Doca 同步与最新版本回读记录分别见 SDD134/162；本发行不声称新的 Doca 写入。
