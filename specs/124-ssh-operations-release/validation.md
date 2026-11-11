# 验证记录

## 发布前

- GitHub #167、#168、#170 均已合入；查询时开放 PR 为 0。
- `origin/main` 为 `902b54fbc3ff82498a8ba7dbaae8af40dea47d6e`，本次 CA 修正从该提交分支。
- 在 `linux/amd64` 与 `linux/arm64` 上用与发行 Dockerfile 同样的 CA bootstrap 和 HTTPS Debian 软件源完成 `apt-get update`；两架构均通过，保留 TLS 及 apt 签名验证。
- 生产当前 Compose、环境文件、主密钥已备份到生产 root 私有目录。SQLite 一致快照为 2,949,316,608 字节，独立 `PRAGMA quick_check` 返回 `ok`，耗时 466.7 秒。
- 生产卷、ClickHouse 及当前中心服务尚未更改。
- 生产旧中心、ClickHouse 均为 Docker healthy，本机 `/healthz` 返回 HTTP 200。公网 `/api/v1/health` 需要认证，部署回读使用本机 `/healthz`。
- 生产 `agent_jobs` 有 1 条历史 queued 记录，已于 2026-11-11T18:48:39.823Z 过期；无未过期 queued/运行中的中心运维任务。
- 仓库站点曾继承 OpenResty 全局 `client_max_body_size 50m`，首次推送收到 HTTP 413。将仅 `docker.heyphp.com` 站点设为 `2g`，原配置备份后 `openresty -t` 通过并热加载；重新推送成功。

## 镜像

- 业务源码：`main` 提交 `16b151337cc94c1b7f3f7de56bdcad561759c85b`（含 #171 构建修正）。
- 固定标签：`docker.heyphp.com/lightmoni/lightmoni:20261112-ssh-managed-operations-v1`；推送前确认不存在，避免覆盖其他内容。
- 远端索引：`sha256:871394dad008209891a5c289a4663c1489af53d9b1b1e9c06c606b800b16035b`。
- `linux/amd64` 清单：`sha256:85d972ffe235d724d79a2143f046fc0db9510fb3012deaf5c6a0f9a039f1e15a`。
- `linux/arm64` 清单：`sha256:d694f28be18f1d5c8fcbeb7d064be34dccfbc6b0c50d6cdc0a0146987bf9fd83`。
- 两架构实际拉取并用 Node 启动 smoke：分别输出 `x64`、`arm64`；中心入口、两架构 Agent 发行包及 AI runner 均存在。
- 使用 `docker image inspect --platform` 回读两架构 OCI revision，均为上述业务源码提交。
- 根 Compose 在提供本地占位 ClickHouse 密码后 `docker compose config --quiet` 通过，`git diff --check` 通过。

## 生产部署与回读

- #171 的 Dockerfile 修正及 #172 的 Compose 固定标签均已合入 `main`；#172 合并提交为 `ea897c1`。发布前查询开放 PR 为 0。
- 生产从私有仓库拉取固定标签，回读镜像索引为 `sha256:871394dad008209891a5c289a4663c1489af53d9b1b1e9c06c606b800b16035b`，OCI revision 为 `16b151337cc94c1b7f3f7de56bdcad561759c85b`。
- 生产 Compose 仅替换中心镜像标签，`docker compose config --quiet` 通过；使用 `docker compose up -d --no-deps --no-build --pull never --wait --wait-timeout 300 lightmoni` 只重建中心，退出码 0，约 32 秒后为 Docker healthy。
- 中心新容器 ID 为 `96ac44a8085469681e90239ef27762d12165a159378d9f225356de9677d8dca0`，镜像为上述索引摘要。中心数据卷仍为 `lightmoni_lightmoni-state-v2-20261103:/data`。ClickHouse 容器 ID 仍为 `428c2c268b044d79cd81ccac3f6269d8cace3531d65bfb0bafd8e78cda1e45747`，保持 healthy，数据卷仍为 `lightmoni_lightmoni-telemetry:/var/lib/clickhouse`。
- 本机 `http://127.0.0.1:1180/healthz` 与公网 `https://moni.heyphp.com/healthz` 均返回 HTTP 200；生产页面能登录并列出 4 台受管主机。
- 4 台机器均为 `direct_ssh`，均有已记录主机公钥和 1 条未撤销、未清除秘密的永久密码凭据；凭据 `expires_at` 为空。旧的 managed 凭据仍为撤销状态。没有在验证记录中保存密码或密钥。
- `zz-bj-1` 的 Agent 升级计划经 SSH 预检，固定当前发行 `7011d507e1db`、目标发行 `16b151337cc9` 及 amd64 包 SHA256 `fc213eaa4683c7a3512b3dc44d13e5295474e329c6dbd6cb29360301b4364644`；审批执行后返回“更新成功”，机器列表回读“当前发行”，Agent 在线。
- Agent 升级后再次回读：中心与原 ClickHouse 容器均为 Docker healthy，本机和公网 `/healthz` 均返回 HTTP 200；`zz-bj-1` 心跳发行提交为 `16b151337cc9`，其余机器心跳发行未变化。
- 其余机器的 Agent 尚未升级：`zsw-hk8c16g-doca-1` 的预检返回“主机没有有效的 Agent 控制凭据”；`zsw-bj-1` 的计划创建结果未确认，操作记录中无新计划，按页面提示未重复创建；`vchive` 存在此前未结束的 Agent 更新且仅监控，未重放更新。中心的 SSH 一次性受管操作依赖机器上新 Agent 命令，因此目前只有 `zz-bj-1` 已确认安装兼容版本；其余三台仍需分别处理既有状态后升级。
