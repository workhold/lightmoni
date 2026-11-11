# 发布计划

1. 以 GitHub `main` 合并提交为业务源码，构建并推送固定标签 `20261112-ssh-managed-operations-v1` 的双架构镜像，验证索引、revision 和中心健康。构建环境的 HTTP Debian 镜像不可达；slim 基础镜像缺少 CA 包，先从相同 Node 全量镜像复制公开 CA bundle，再通过 HTTPS Debian 镜像下载安装并保留 apt 签名校验。该构建修正随本次发布 PR 记录。
2. 在功能分支更新根 Compose 固定标签，保存验证证据，创建并合入面向 `main` 的 PR。
3. 在生产 1Panel 主机确认当前 Compose 项目、镜像和运行状态；保存原配置及 SQLite 一致快照，独立执行 `quick_check`。
4. 拉取固定标签并核对摘要，仅重建中心服务，检查 Docker health 与公网 `/api/v1/health`，核对其他容器和卷不变；失败按旧 Compose 回退。

发布前的签名任务仍需等待或核对，避免重建中心时遗留未知状态。所有生产秘密和原始备份仅留在生产 root 私有目录，证据只保存非敏感摘要与状态。
