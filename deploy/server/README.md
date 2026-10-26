# Docker 更新与回滚

根目录 `compose.yaml` 默认同时管理中心与 ClickHouse；`deploy/with-clickhouse/compose.yaml` 保留为兼容入口并继承相同服务。中心镜像默认 `docker.heyphp.com/lightmoni/lightmoni:20261026-admin`。两端账号密码通过 `LIGHTMONI_CH_USER/PASSWORD` 注入，中心默认使用 `LIGHTMONI_CH_URL=http://clickhouse:8123`。选择对应目录 `.env` 并沿用项目名，使 SQLite/主密钥与遥测卷继续匹配原实例。

## 更新

1. 在所选 `.env` 中填写要部署的 `LIGHTMONI_IMAGE` 固定标签或 digest；私有仓库先运行 `docker login docker.heyphp.com`。源码构建时另外填写 `LIGHTMONI_BUILD_REVISION` 为 `git rev-parse HEAD`。`0.1.0` 是应用/包版本，不能单独证明源码已更新。
2. 保留旧镜像标签及受限的旧 `.env`。备份配套的 SQLite、主密钥与 ClickHouse 数据；备份文件与配置仅允许运维用户读取。
3. 如网络需要，在 `.env` 中选择公开 npm、Node 归档、Debian 和 Debian security 镜像源；默认官方源不变。Node 归档仍与官方发行站的 SHA256 清单校验。镜像源不得携带凭据、token 或查询参数；不要关闭证书、npm integrity 或 Debian 签名校验。
4. 从仓库根目录执行下面的命令。只部署中心时将 `-f` 改为 `compose.yaml`，并使用根目录 `.env`。

```sh
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml config --quiet
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml pull lightmoni
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml up -d --no-build --wait
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml ps
```

通过 `docker image inspect <镜像标签> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'` 核对镜像提交；随后检查网页、原有管理员登录、只读查询和 SDK/Agent 下载。需要 `up` 重新创建容器才能切换镜像；本地 `npm run build`、`release:sdk` 和 `release:agent` 只更新本地生成物。

## 回滚与已有临时配置迁移

将 `.env` 的 `LIGHTMONI_IMAGE` 改回保留的旧镜像，使用同一项目名与 Compose 文件执行 `up -d --no-build --wait`。这会保留两个命名卷。如果升级已执行无法向后兼容的存储迁移，先停止中心，按配套备份恢复 SQLite、主密钥和需要恢复的 ClickHouse 数据，再启动旧镜像；只换旧镜像不能替代数据恢复。

从历史临时 Compose JSON 迁移时，先核对 `com.docker.compose.project`、容器端口、数据库账号和两个卷名。把相同项目名与连接信息写入 0600 的 `.env`，改用仓库标准 Compose；不要重新生成主密钥、创建同名以外的空数据卷或运行 `down -v`。迁移后后续更新继续使用这份标准配置。

源码构建时将 `pull lightmoni` 替换为 `build lightmoni`，并在 `up` 添加 `--pull never`，防止远端镜像覆盖本地构建。

## 管理员初始化与密码恢复

没有默认用户名/密码；可以在首次访问网页时创建，或在中心首次启动前执行：

```sh
docker compose run --rm --no-deps --entrypoint lightmoni-admin lightmoni init --name admin
```

默认无回显输入并确认密码，至少 8 个 Unicode 字符、最多 72 个 UTF-8 字节。只允许空用户库初始化；已有任何用户时会拒绝。

已有管理员密码重置：

```sh
docker compose exec lightmoni lightmoni-admin reset-password --name admin
```

停止中心时可改为 `docker compose run --rm --no-deps --entrypoint lightmoni-admin lightmoni reset-password --name admin`。账号名称需精确匹配已有管理员；不会创建未知用户、提升成员或重新启用禁用账号；密码修改和该用户全部会话删除在同一 SQLite 事务内完成，其他用户和加密主密钥不变。命令仅需要状态卷权限，不依赖 ClickHouse，无需旧密码。

自动化通过受限文件或密码管理器传入单行密码，不使用命令行明文参数：

```sh
# /secure/admin-password 是由运维预先提供、权限为 0600 的文件。
docker compose exec -T lightmoni lightmoni-admin reset-password --name admin --password-stdin < /secure/admin-password
```

本地源码先 `npm --prefix runtime run build`，再执行 `LIGHTMONI_DATA=/path/to/state npm run admin -- init --name admin` 或 `reset-password`。务必指向与中心相同的数据目录（默认 `.lightmoni`，容器 `/data/state`），不要为恢复密码重新生成主密钥。

管理员命令是受本机/容器执行权限保护的直接 SQLite 运维入口；架构影响、仓库/Doca 同步与验收见 [SDD 023](../../specs/023-registry-admin-cli/spec.md)。
