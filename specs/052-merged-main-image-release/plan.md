# 发布设计

先合入 #27，再将最新 origin/main 合并到 #28，运行集成检查后推送功能分支并通过 GitHub 合入。固定最终 main 的完整 SHA 作为镜像源码 revision；从 git archive 导出构建上下文，排除开发依赖、运行数据和凭据。

复用现有 Dockerfile 和前次验收/发布流程，两平台分别构建并记录 build metadata；基础镜像使用既有固定 Node 版本，npm integrity、Debian 签名与 Node 官方 SHA256 验证保留。隔离空卷与网络执行镜像验收，amd64 在本机 ARM64 Docker 仿真运行，如实记录限制。

复用 OCI 分块上传：先校验所有本地 blob 和验收镜像的配置/rootfs，使用 Docker Desktop 凭据助手在进程内提供认证，按 512 KiB 上传缺失层，再写平台 manifest 与固定标签；更新 latest 前核对其未并发变化。独立客户端回读索引并拉取双平台验证。

发布成功后，`codex/052-merged-main-image-release` 更新 Compose、README、部署说明和文本证据，创建并合入 GitHub PR。GitHub release 绑定构建源码提交，发布说明关联镜像摘要、功能 PR、兼容变化与验收边界。本地最终切回 main 并仅快进同步。
