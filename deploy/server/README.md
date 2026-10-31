# Docker 更新与回滚

根目录 `compose.yaml` 默认同时管理中心与 ClickHouse；`deploy/with-clickhouse/compose.yaml` 保留为兼容入口并继承相同服务。中心镜像直接指定为 `docker.heyphp.com/lightmoni/lightmoni:20261031-aed4b2d`，无需在 `.env` 指定。两端账号密码通过 `LIGHTMONI_CH_USER/PASSWORD` 注入，中心默认使用 `LIGHTMONI_CH_URL=http://clickhouse:8123`。选择对应目录 `.env` 并沿用项目名，使 SQLite/主密钥与遥测卷继续匹配原实例。

## 更新

1. 执行 `git pull --ff-only origin main` 获取根 Compose 维护的固定发布镜像，不再通过 `.env` 中的 `LIGHTMONI_IMAGE` 选择版本；私有仓库先运行 `docker login docker.heyphp.com`。源码构建时另外填写 `LIGHTMONI_BUILD_REVISION` 为 `git rev-parse HEAD`。`0.1.0` 是应用/包版本，不能单独证明源码已更新。
2. 保留旧镜像标签及受限的旧 `.env`。备份配套的 SQLite、主密钥与 ClickHouse 数据；备份文件与配置仅允许运维用户读取。
3. 如网络需要，在 `.env` 中选择公开 npm、Node 归档、Debian 和 Debian security 镜像源；默认官方源不变。Node 归档仍与官方发行站的 SHA256 清单校验。镜像源不得携带凭据、token 或查询参数；不要关闭证书、npm integrity 或 Debian 签名校验。
4. 从仓库根目录执行下面的命令。使用根目录部署入口时将 `-f` 改为 `compose.yaml`，并使用根目录 `.env`；两个入口都会管理中心与 ClickHouse。

```sh
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml config --quiet
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml pull lightmoni
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml up -d --no-build --wait
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml ps
```

通过 `docker image inspect <镜像标签> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'` 核对镜像提交；随后检查网页、原有管理员登录、只读查询和 SDK/Agent 下载。需要 `up` 重新创建容器才能切换镜像；本地 `npm run build`、`release:sdk` 和 `release:agent` 只更新本地生成物。

`20261031-aed4b2d` 从已合入 PR #42 的 `aed4b2ddedcd4eb446cc4097a0e205a1aa5f52a9` 在本机完整重建：证书按单个域名或泛域名命名，无独立名称输入；同步任务放在对应域名下，机器目录可选择整个集群，并逐机器记录结果与重试。全部当前成员验证版本和指纹后才显示已应用；历史证书材料和引用保留。已有查看/下载证书与私钥、异步申请日志、OpenResty 安装引导和按需集群管理入口一并保留。固定标签与 `latest` 的双架构摘要、实际容器与下载核对见 [SDD 057 发布验收](../../specs/057-domain-certificate-sync/release-validation.md)。旧 `.env` 中的 `LIGHTMONI_IMAGE` 可删除，不再影响此入口；单独拉取不会更新运行实例，仍需执行 `up`。旧固定标签保留供回退，[SDD 056](../../specs/056-acme-invalid-order-diagnostics/release-validation.md)、[SDD 055](../../specs/055-main-image-release/validation.md) 和 [SDD 052](../../specs/052-merged-main-image-release/validation.md) 保留历史发布记录。

中心镜像更新不会自动更新已安装的 Agent。需要使用新运维能力的节点应单独升级 Agent，并按[运维手册](../../docs/operations.md)准备 Nginx、Docker/Compose 等所需依赖及目录、服务权限；不能仅凭 capability 出现就认定节点已有执行权限。公网 ACME 与真实 S3 等未验收范围仍以 [SDD 026](../../specs/026-operations-platform/validation.md)为准。

## SDK 接入迁移

本版附带的新 Agent 不再提供业务 SDK 的 OTLP 接收与配置代理。原先 SDK→Agent 接入须在升级 Agent 前迁移为中心 endpoint 与 SDK Key；新 SDK 必须显式设置中心 endpoint。既有 Agent 不会仅因中心换镜像而自动升级。内网/公网入口配置及迁移方法见 [中心入口发现](../../docs/center-endpoints.md)。

## 主机 IP 与可信反向代理

新版 Agent 在注册/心跳时采集本机网卡地址，主机管理区分 SSH 连接地址、内网 IP、其他网卡 IP 和平台观测来源 IP。支持多网卡 IPv4/IPv6；不依赖第三方 IP 查询，不根据 IP 合并主机。Agent 更新前显示“待发现”，旧 Agent 未提供网卡字段时保留已有快照及原观测时间。

中心默认使用 TCP 对端地址，忽略客户端发送的 `X-Forwarded-For`。如果中心位于 Nginx 或其他反向代理后，在 `.env` 配置 `LIGHTMONI_TRUSTED_PROXIES` 为中心实际看到的代理 IP/CIDR，多个用逗号分隔，例如 `172.20.0.1/32,::1/128`；根 Compose 已透传，继承入口同步生效。只填写实际受控代理地址，不要信任用户主机网段或全部地址；代理应覆盖或追加真实连接来源到 `X-Forwarded-For`。

只有直接对端受信时才从右向左剥离已知代理，取第一个非受信来源；可信代理缺少或传入无效地址链时显示“来源待发现”。无效信任 IP/CIDR 配置会拒绝启动。平台观测地址可能是内网、NAT、VPN 或代理的出口，只代表访问当前平台的路径，不代表所有出口或可从公网连接的地址。更换 Agent 身份后，不将旧 Agent 的地址快照当作当前数据。

## 回滚与已有临时配置迁移

需要回滚时，在所选 Compose 目录创建本地覆盖文件 `compose.rollback.yaml`，指定保留的旧镜像，避免修改仓库维护的 `compose.yaml`：

```yaml
services:
  lightmoni:
    image: docker.heyphp.com/lightmoni/lightmoni:20261027-ec30880
```

```sh
docker compose -f compose.yaml -f compose.rollback.yaml pull lightmoni
docker compose -f compose.yaml -f compose.rollback.yaml up -d --no-build --wait
```

回滚期间的后续命令继续携带该覆盖文件。原 `.env` 中的 `LIGHTMONI_IMAGE` 不再选择版本；恢复仓库维护版本时省略覆盖文件，重新执行 `pull` 和 `up`。沿用同一项目名和基本 Compose 配置会保留两个命名卷。如果升级已执行无法向后兼容的存储迁移，先停止中心，按配套备份恢复 SQLite、主密钥和需要恢复的 ClickHouse 数据，再启动旧镜像；只换旧镜像不能替代数据恢复。

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
