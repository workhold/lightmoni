# SDD 185 发布计划

1. 在基于最新 `origin/main` 的发布分支运行 `version:bump -- 0.1.7`，复查全部版本点与 Compose 固定标签，提交并合入面向 `main` 的版本 PR。
2. 同步合并后的 `main`，从固定提交本地构建 linux/amd64 镜像，核对 OCI revision、内置 Agent/SDK 发行包和隔离健康，再推送双标签并回读远端摘要。
3. 通过现有 1Panel/Compose 项目做轻量一致性备份和固定标签切换；核对中心、ClickHouse、卷及业务现状，必要时使用升级前固定标签回滚。
4. 在 LightMoni 平台对 `zz-bj-1` 发起一键 Agent 升级，核对原生维护记录及远端服务、发行身份和 Registry 容器；只将实际完成的步骤写入验收记录。
