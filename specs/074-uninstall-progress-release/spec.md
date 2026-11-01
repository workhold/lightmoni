# 卸载进展修复 Docker 发行

日期：2026-11-01。用户授权将 PR #60 合入 main 并发布 Docker。

从 GitHub main 合并提交 `1c82e6b64e8432bd449b957eebf8141aa08e04e6` 的固定 git archive 构建完整中心镜像，包含生产网页、双架构 Agent 和四种 SDK。发布到 `docker.heyphp.com/lightmoni/lightmoni:20261101-1c82e6b` 与 `latest`，支持 linux/amd64、linux/arm64。

验收必须包括原有中心/ClickHouse、下载包及摘要和本轮卸载入口、状态自动刷新、固定操作区域的实际打包结果。固定版本和 latest 回读摘要、两个平台独立拉取后核对实际测试镜像的 rootfs/config；历史固定标签保留。更新根 Compose 和文档默认版本，经发布 PR 合入 main，并创建对应 GitHub Release。

范围为合入与发布，沿用既有镜像和更新流程，不重建用户生产中心或操作远端主机卸载。运行凭据仅使用受保护的本地临时文件/系统凭据存储，不进入构建上下文、日志、PR 或文档。

架构同步不适用：仅打包 SDD073 的现有网页行为修复，不改变职责、服务端控制路径、协议、存储、凭据或部署拓扑；docs/system-design.md 和 Doca 无受影响章节。
