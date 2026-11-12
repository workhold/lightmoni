# SDD130 验证记录

日期：2026-11-12。分支：`codex/130-ssh-once-release`。按实际结果补充，未完成的发布或生产步骤保持待验。

## 源码与发布前检查

- GitHub `origin/main` 为 `bb132a10e1d65edd77354b09d3add32df90ec936`，包含 PR #176 的 SDD129 修复。从该提交使用 `git archive` 建立独立干净构建上下文，不使用带未提交改动的工作树；归档中有 3422 个文件。
- 推送前执行 `docker buildx imagetools inspect docker.heyphp.com/lightmoni/lightmoni:20261112-ssh-once-readiness-v3`，退出码 1，返回 `not found`，固定标签当时不存在。构建使用 `linux/amd64,linux/arm64`、完整 `BUILD_REVISION`、HTTPS Debian 主源及安全源，保留 TLS 和包签名校验。

## 固定镜像构建与独立回读

- 从上述干净归档执行 `docker buildx build --platform linux/amd64,linux/arm64 --provenance=false --progress=plain`，传入 `BUILD_REVISION=bb132a10e1d65edd77354b09d3add32df90ec936`、`DEBIAN_MIRROR=https://deb.debian.org/debian`、`DEBIAN_SECURITY_MIRROR=https://deb.debian.org/debian-security`，以新固定标签推送成功。构建日志最终显示两个平台清单、索引及远端 manifest 推送完成，无错误。
- 从远端独立执行 `docker buildx imagetools inspect` 与 `--raw`，回读 Docker manifest list 索引 `sha256:76fa91fa1a470b6868e354d33113a8a50180d48975eea7016acb99c4959b79ec`；`linux/amd64` 清单为 `sha256:d7f6b5fca9a373b4ca31d4d13aa7ac6a6175a1d0a50092a2fe2a2d7839177b1b`，`linux/arm64` 清单为 `sha256:6c166391a453812aea7ba25c0b9c1e3a6242c6853adf98d98bd7eee3c77e82da`。远端索引与构建回执一致。
- 两个平台清单分别按摘要执行 `docker pull --platform` 成功，拉取回执摘要相符。对实际拉取镜像执行 `docker image inspect --platform`，得到架构 `amd64`、`arm64`，OCI `org.opencontainers.image.revision` 均为完整源码提交 `bb132a10e1d65edd77354b09d3add32df90ec936`。
- 两个平台镜像分别以 `docker run --rm --platform ... --entrypoint node` 实际启动，Node 分别报告 `x64`、`arm64`；中心入口、两个 Agent 下载包和 AI runner 均为文件，两个 `.tar.gz` 均通过 `tar -tzf`。从各自对应 Agent 包内回读 `release.json`，`platform=linux`、`arch=amd64/arm64`、`source_revision=bb132a10e1d65edd77354b09d3add32df90ec936`、`state_schema=1` 均匹配。

## Compose 与文档

- 根 Compose 仅将 `services.lightmoni.image` 从 `20261112-ssh-once-readiness-v2` 改为候选 v3 标签；端口、环境、依赖、卷和 ClickHouse 配置不变。
- 发布执行方确认 v2 仅合入仓库，未部署生产；生产当前运行镜像须在部署前现场回读，回滚基线以现场实际版本为准。
- 使用 `LIGHTMONI_CH_PASSWORD=placeholder docker compose config --quiet` 检查通过；占位值未写入仓库。文档格式和 `git diff --check` 已通过。

## GitHub PR

- 面向 `main` 创建 [PR #177](https://github.com/workhold/lightmoni/pull/177)，标题为 `chore(release): pin SSH once readiness v3 image`，首次提交 `cb17fa4f2b07d6e03785507637f59e6e195f2ae6`。PR 描述记录最终行为、v2 未上线的兼容影响、双架构发行验证、生产待办及架构影响不适用的理由，并链接仓库设计与 Doca 基线。
- 创建后 GitHub 返回 `mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`；`gh pr checks 177` 报告此分支没有配置的检查。合并与最终合并提交须在实际完成后回读，不预填。

## 尚待验证

- GitHub PR 合并提交和生产 Compose 最终版本。
- 生产未完成签名任务、受保护备份及 SQLite `quick_check`、固定镜像拉取、仅中心重建、容器与卷身份、健康接口，以及 SDD127/129 兼容回读；如无安全的历史队列样本，生产仅记录可验证边界。
- 原镜像与本地回滚覆盖文件在生产的可用性。

生产部署尚未执行；本地镜像构建和 smoke 不代表生产服务或主机 Agent 的在线验收。

## 架构同步

不适用。本次只发行已合入的 SDD127 与 SDD129 实现，并更新现有 Compose 固定标签；未改变组件职责、协议、控制路径、凭据边界、存储或部署拓扑。SDD127 的仓库与 Doca 回读见 [验收记录](../127-ssh-once-readiness/validation.md)，SDD129 的非架构性修复理由见 [验收记录](../129-ssh-legacy-queue-failure/validation.md)。
