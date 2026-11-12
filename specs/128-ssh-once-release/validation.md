# SDD128 验证记录

日期：2026-11-12。分支：`codex/128-ssh-once-release`。本文件按实际完成情况增补；当前记录本地发布准备和独立发行物回读。

## 本地准备

- 分支从 GitHub `origin/main` 提交 `9ec010acd732a3bca5938236a429b3b64a88d941` 创建，包含已合入的 SDD127 PR #174。
- 根 Compose 仅将 `services.lightmoni.image` 从 `20261112-ssh-managed-operations-v1` 改为候选标签 `20261112-ssh-once-readiness-v2`；其他服务和配置未改。
- 使用 `LIGHTMONI_CH_PASSWORD=placeholder docker compose config --quiet` 检查通过；`git diff --check` 通过。占位值未写入仓库。

## 固定镜像独立回读

- 构建执行方已从上述 `main` 提交构建并推送 `docker.heyphp.com/lightmoni/lightmoni:20261112-ssh-once-readiness-v2`。本轮从远端独立执行 `docker buildx imagetools inspect` 与 `--raw`：索引类型为 Docker manifest list，摘要 `sha256:130016bac46e32609c3524831156e18f701734ca8b3e21f06eab1a4544d960c6`。
- `linux/amd64` 清单为 `sha256:b8a6b6dbec92ac554241ebb4dd3b6aaecec0e7a77123dda2ab0e0407ef2ac5b8`；`linux/arm64` 清单为 `sha256:a86ea90aff565cff4157771d6d41fcc741168c029756cde6c9dbf310fe86ef2b`。两个清单均按各自摘要执行 `docker pull --platform` 成功，拉取回执摘要相符。
- 对拉取的两个平台镜像分别执行 `docker image inspect --platform`：架构为 `amd64`、`arm64`，OCI `org.opencontainers.image.revision` 都是完整源码提交 `9ec010acd732a3bca5938236a429b3b64a88d941`。
- 两个平台都以 `docker run --rm --platform ... --entrypoint node` 实际启动：分别报告 Node `x64`、`arm64`；中心入口、两个 Agent 下载包、AI runner 均为文件，两个 `.tar.gz` 均通过 `tar -tzf` 完整性检查。进一步从下载包内回读 `release.json`：amd64 与 arm64 包各自声明匹配的 `arch`，`source_revision` 均为上述完整提交，`state_schema=1`。
- 构建执行方在推送前执行 `docker buildx imagetools inspect docker.heyphp.com/lightmoni/lightmoni:20261112-ssh-once-readiness-v2`，退出码 1、结果为 `not found`，确认标签当时未占用。该历史检查由构建执行方提供；本轮独立验证确认推送后的远端内容与 revision 匹配。
- 在提交发布 PR 前再次拉取 GitHub `origin/main`，仍为 `9ec010acd732a3bca5938236a429b3b64a88d941`，发布分支与主干无新提交需要同步。

## 尚待验证

- GitHub PR、合并提交与最终生产 Compose 版本。
- 生产未完成签名任务、受保护备份及 SQLite `quick_check`、固定镜像拉取、仅中心重建、容器和卷身份、健康接口与 SDD127 兼容回读。
- 回滚镜像和本地覆盖文件在生产的可用性。

生产部署尚未执行；本轮双架构容器启动仅是本地镜像内容 smoke，不代表生产服务或 Agent 的在线验收。

## 架构同步

不适用。本次仅发行已在 SDD127 完成仓库与 Doca 同步、最新版本回读的实现，并更新 Compose 固定标签；没有新增组件职责、协议、控制路径、凭据边界、存储或部署拓扑。SDD127 回读结果见 [其验收记录](../127-ssh-once-readiness/validation.md)。
