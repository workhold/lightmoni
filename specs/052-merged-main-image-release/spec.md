# 合入待发布功能并发布主分支镜像

日期：2026-10-31。用户授权：合入本账号提交且尚未合并的 PR，本地同步 main，发布 Docker 仓库并更新 GitHub。

## 范围

- 合入 smartdoca 的 #27（DNS 批量解析）和 #28（中心入口发现与 SDK 直报），#28 同步当前 main 并完成集成检查后解除草稿、通过 PR 合入。
- 本地仓库切换 main 并快进到 origin/main；保留现有未提交内容，不直接推送主干。
- 从合入后固定源码提交导出干净上下文，在本机 Docker Desktop 完整构建 Linux amd64/arm64 中心镜像，包含前端、AI runtime、双架构 Agent 与四种 SDK。
- 通过受保护的现有 Docker 凭据发布 `docker.heyphp.com/lightmoni/lightmoni:20261031-<源码短提交>`；验收后更新 latest。旧固定版本保留。
- 更新根 Compose 默认镜像、部署说明和发布证据，经新功能分支 PR 合入 main；GitHub 创建同名发布标签与说明，最后同步本地 main。

## 验收

1. 两个功能 PR 以及发布记录 PR 均为 merged，目标 main；本地 main 和 origin/main 一致、工作区干净。
2. 合并版本的类型检查、构建与 Runtime/SDK/AI/Web 相关回归通过，环境跳过明确记录。
3. 双平台镜像以非 root 用户运行，revision 对应固定源码；隔离容器连接真实 ClickHouse，验证健康、管理员登录、网页、运维/任务接口、Agent 和 SDK 下载校验。
4. 固定标签与 latest 指向同一双平台 OCI 索引；回读 manifest、config、层摘要和长度，重新按两平台拉取，核对与验收镜像一致。
5. 仅清理本次创建的测试容器、卷、网络和临时凭据。不升级现有本地/线上实例，不向 Gitea 写入。

## 架构影响

本次发布不适用。功能 #28 的架构与 Doca 同步已在其 SDD/PR 内完成；本次仅合入已验证功能、构建制品和更新固定镜像引用，不新增组件、数据/控制路径、存储、协议、凭据边界或拓扑。无需重新改写 `docs/system-design.md` 或 Doca。
