# 发布契约

- Git：GitHub workhold/lightmoni 的 origin；所有 main 更新通过 PR。
- 镜像：docker.heyphp.com/lightmoni/lightmoni；固定标签 `20261031-c209a18` 不覆盖不同内容，latest 仅在隔离验收和固定标签回读成功后更新。
- 平台：linux/amd64、linux/arm64；OCI revision 必须等于 `c209a1853610e951709adf8ff8053167a2aec293`。
- 凭据仅经受保护的现有 credential helper 提供，不进入源码、命令参数、URL、构建层、日志或 GitHub 正文。
- 保留历史固定标签及现有服务；仅清理本次专属验收容器、卷、网络和运行凭据文件。
- GitHub release 与镜像固定标签同名，绑定构建源码并记录功能 PR、摘要、平台、兼容影响和验收范围。
