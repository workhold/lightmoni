# 发布设计与契约

1. 固定 PR #60 的合并回执与源码 SHA，确认功能分支检查结果；从合入源码的 git archive 构建，不带工作区内容或运行凭据。
2. 沿用 Docker Desktop 和仓库 Dockerfile，分别构建两个 Linux 平台，记录 context SHA256、构建材料、revision 标签、测试镜像 ID 和发布 manifest。
3. 启动隔离 ClickHouse 与各平台中心；验证健康、管理员登录、中心身份、下载与 SHA256、打包 Agent 运行和既有功能。核对生产网页包含本次直接恢复卸载、真实状态刷新及固定操作区域；SDD073 的 52 项浏览器检查为交互验收依据。
4. 镜像平台内容与测试 rootfs/config 一致后上传，固定标签拒绝异内容覆盖；latest 更新前核对并发变化。回读远端 index、platform manifest/config，重新拉取两个平台并验证；历史固定标签不能变化。
5. 清理仅本次创建的测试容器、网络、卷及临时运行凭据。创建 GitHub Release，更新 Compose 和部署说明固定标签，通过发布 PR 合入 main，记录证据及生效范围。
