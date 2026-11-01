# 发布设计

1. 从已合入 main 的固定 SHA 生成 git archive 构建上下文，排除工作区和运行时凭据。
2. 沿用仓库 Dockerfile、固定 Node、包锁完整性和已有镜像源，分别构建 linux/amd64、linux/arm64。
3. 在临时独立网络/卷运行生产中心和 ClickHouse，核对实际 API、31 个目录、DBX 密码规则、生产网页、两架构 Agent/SDK 摘要、初始化执行能力。
4. 沿用已核对的 OCI 发布脚本；上传前核对 SHA256 与实测 rootfs/config，固定版本禁止覆盖异内容，latest 检查并发变化；凭据只在 Docker helper/权限 0600 的临时环境中。
5. 发布后独立 Docker CLI 重新拉取双平台，核对远端 manifest/config/index、历史固定标签。清理本轮临时服务和凭据。
6. GitHub Release 指向同一源码；默认镜像、部署文档与不含凭据的证据通过发布 PR 合入 main。
