# 发布设计

1. 已同步 origin/main，PR #49 从草稿转正式并通过 GitHub merge 合入；本机 main 快进到实际合入提交。
2. 在新功能分支记录发行 SDD；构建上下文来自 main 固定提交的 git archive，排除未提交文件与运行时凭据。沿用既有 Dockerfile 和已验证本机发布/验收脚本。
3. 分别构建两个平台并执行隔离容器验收；保持真实健康/登录/下载检查，追加本次应用管理和命名端口的生产包核对。既有共享服务不改动。
4. 读取受保护 Docker credential helper，仅在进程中使用凭据；上传前核对本地全部 OCI SHA256，保留旧固定标签，latest 更新前核对并发变化。独立 Docker 客户端回读、重新拉取核对 rootfs/config/revision。
5. 创建 GitHub Release，更新默认 Compose/部署文档与证据，经新 PR 合入 main。最后快进本地 main 并核对工作区。
