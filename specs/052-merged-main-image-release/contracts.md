# 发布契约

- 主库与远端：GitHub workhold/lightmoni，origin；所有仓库写入通过功能分支与 main PR。
- Docker 仓库：docker.heyphp.com/lightmoni/lightmoni。固定标签 `20261031-<源码短SHA>` 不覆盖不同内容；latest 仅在双平台验收和固定标签回读成功后更新。
- Linux 平台：amd64、arm64；OCI `org.opencontainers.image.revision` 必须等于完整源码 SHA。最终部署配置提交可以晚于该 SHA，仅包含发布配置与证据。
- 凭据由现有 Docker credential helper 提供，只保留进程内存；禁止进入源码、镜像层、命令参数、输出、URL 或 GitHub 正文。
- 构建与验收采用本机 Docker、独立资源；既有运行实例及历史固定版本不自动切换或删除。
- GitHub release 标签与镜像固定标签同名，指向构建源码；说明列出合入功能、SDK 直报中心的兼容要求、平台摘要与验证范围。
