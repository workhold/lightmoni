# Docker 更新与回滚

根目录 `compose.yaml` 连接现有 ClickHouse；`deploy/with-clickhouse/compose.yaml` 同时管理中心与 ClickHouse。两种配置共用 Dockerfile 和构建参数。选择对应目录的 `.env`，使用已有项目名，使 SQLite/主密钥与遥测卷继续匹配原实例。不要在源码、命令行或 Compose JSON 中写入真实密码。

## 更新

1. 更新源码，记录 `git rev-parse HEAD`；在所选 `.env` 中填写匹配的 `LIGHTMONI_BUILD_REVISION` 和唯一 `LIGHTMONI_IMAGE` 标签。`0.1.0` 是应用/包版本，不能单独证明源码已更新。
2. 保留旧镜像标签及受限的旧 `.env`。备份配套的 SQLite、主密钥与 ClickHouse 数据；备份文件与配置仅允许运维用户读取。
3. 如网络需要，在 `.env` 中选择公开 npm、Node 归档、Debian 和 Debian security 镜像源；默认官方源不变。Node 归档仍与官方发行站的 SHA256 清单校验。镜像源不得携带凭据、token 或查询参数；不要关闭证书、npm integrity 或 Debian 签名校验。
4. 从仓库根目录执行下面的命令。只部署中心时将 `-f` 改为 `compose.yaml`，并使用根目录 `.env`。

```sh
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml config --quiet
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml build lightmoni
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml up -d --no-build --wait
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml ps
```

通过 `docker image inspect <镜像标签> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'` 核对镜像提交；随后检查网页、原有管理员登录、只读查询和 SDK/Agent 下载。需要 `up` 重新创建容器才能切换镜像；本地 `npm run build`、`release:sdk` 和 `release:agent` 只更新本地生成物。

## 回滚与已有临时配置迁移

将 `.env` 的 `LIGHTMONI_IMAGE` 改回保留的旧镜像，使用同一项目名与 Compose 文件执行 `up -d --no-build --wait`。这会保留两个命名卷。如果升级已执行无法向后兼容的存储迁移，先停止中心，按配套备份恢复 SQLite、主密钥和需要恢复的 ClickHouse 数据，再启动旧镜像；只换旧镜像不能替代数据恢复。

从历史临时 Compose JSON 迁移时，先核对 `com.docker.compose.project`、容器端口、数据库账号和两个卷名。把相同项目名与连接信息写入 0600 的 `.env`，改用仓库标准 Compose；不要重新生成主密钥、创建同名以外的空数据卷或运行 `down -v`。迁移后后续更新继续使用这份标准配置。

本次只执行既有中心 + ClickHouse 拓扑并提供构建源/修订号参数，架构同步不适用；见 [SDD 022](../../specs/022-docker-main-alignment/spec.md)。
