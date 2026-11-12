# 发布计划

## 发行物准备

1. 确认 `origin/main` 为 `bb132a10e1d65edd77354b09d3add32df90ec936`，从该提交创建干净构建上下文；确认候选 v3 固定标签尚未存在。标签已占用时停止并选择新标签，不覆盖。
2. 用 `deploy/server/Dockerfile` 构建并推送 `linux/amd64,linux/arm64` 索引，设置 `BUILD_REVISION` 为完整提交。沿用 SDD124 已验证的 HTTPS Debian 镜像源参数，保持 TLS 与签名校验。
3. 从远端回读索引与两个架构清单，实际拉取双架构镜像；核对 OCI revision、中心入口、两个 Agent 下载包及 AI runner。记录摘要和结果后才将候选镜像视为可发布。
4. 在独立功能分支将根 Compose 的中心镜像改为 v3 固定标签，运行 `docker compose config --quiet` 与 `git diff --check`，通过面向 `main` 的 PR 合入。PR 描述写明最终行为、兼容影响、架构影响不适用的理由及验证证据。

## 生产发布

5. 在生产原 Compose 项目中确认当前中心、ClickHouse、镜像和卷；v2 从未上线，不能以仓库当前 v2 标签代替实际运行镜像作为备份与回滚基线。等待或核对未完成的签名运维任务，避免重启中心时形成未知状态。确认生产 QA 已结束。
6. 将当前 Compose、`.env`、主密钥和容器元信息备份到生产 root 私有目录；以 SQLite 在线备份 API 生成一致快照，并在独立连接执行 `PRAGMA quick_check`。保留旧镜像与现有卷，不以复制运行中的 SQLite 文件代替一致备份。
7. 拉取经验证的 v3 固定镜像，核对摘要和 revision；在原项目目录运行 `docker compose config --quiet`，然后执行 `docker compose up -d --no-deps --no-build --pull never --wait --wait-timeout 300 lightmoni`，只重建中心。
8. 核对中心 Docker health、本机与公网 `/healthz`，并确认 ClickHouse 容器 ID、健康状态以及两类数据卷均保持不变。回读 SDD127 的旧发行升级提示、精确迁移发行和显式单次能力；特别核对 SDD129 的历史受管队列为 `failed` / `agent_upgrade_required`，没有新签名作业或 SSH 派发。不得为验收在生产主机上制造不可逆的作业；如无自然样本，使用发行测试证据并如实标注生产未复现。其他主机未在线或未升级时记录限制。
9. 若中心健康或兼容验收失败，在相同 Compose 项目用本地回滚覆盖文件指定已验证的旧固定镜像，仅重建 `lightmoni` 并再次回读健康。程序回滚保留现有数据；数据恢复须单独核对备份与兼容性，不使用 `down -v`。

## 发布边界

新镜像索引、生产备份和部署验收在实际完成后写入 `validation.md`。构建或部署中的未确认步骤保持待办；生产秘密、密码、密钥及原始备份只留在生产受保护目录。本发布不自动升级 Agent，也不修复其他主机历史身份或安装状态。SDD127 已完成的架构同步与 SDD129 非架构性变更分别见[验收记录](../127-ssh-once-readiness/validation.md)和[修复规格](../129-ssh-legacy-queue-failure/spec.md)。
