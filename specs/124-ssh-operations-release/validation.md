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

## 待完成

发布 PR、生产切换与健康回读。
