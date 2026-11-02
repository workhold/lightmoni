# Docker 部署与更新

部署统一使用仓库根目录 `compose.yaml`，同时管理中心与 ClickHouse。中心使用固定发布镜像 `docker.heyphp.com/lightmoni/lightmoni:20261102-ccbb85d`，支持 Linux amd64/arm64。两端账号密码由 `.env` 的 `LIGHTMONI_CH_USER/PASSWORD` 注入，中心默认连接 `http://clickhouse:8123`；数据库不映射宿主端口。

## 初始化与更新

首次部署从根目录复制 `.env.example` 为 `.env`、设为 0600 并填写数据库密码、端口与域名。SQLite、主密钥和队列保存在 `lightmoni-state`，遥测保存在 `lightmoni-telemetry`。更新时保持相同项目名、环境与数据卷，并配套备份两卷和 `.env`。

```sh
git pull --ff-only origin main
docker compose config --quiet
docker compose pull lightmoni
docker compose up -d --no-build --wait
docker compose ps
```

私有仓库先执行 `docker login docker.heyphp.com`。通过 `docker image inspect <镜像标签> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'` 核对源码提交，再检查登录、查询及 SDK/Agent 下载。源码构建需设置 `LIGHTMONI_BUILD_REVISION` 为 `git rev-parse HEAD`，执行 `docker compose build lightmoni`，启动时添加 `--pull never`。镜像源可按根 `.env.example` 配置；不关闭 TLS、npm integrity 或 Debian 签名校验。

当前存储只接受首次正式发布基线。没有 `center_schema=1` 标记的旧开发数据库会被明确拒绝；程序不执行升级、搬运或删除。需要保留的开发数据应由管理员先备份，再使用全新状态和遥测目录。清理与发布验收见 [SDD081](../../specs/081-prerelease-cleanup/validation.md)。

普通 Agent 保持非 root、无 Docker 权限。应用、网站、Compose、证书和备份写操作由独立执行器及默认关闭的 `operations.managed.v1` 承接，业务数据使用独立 root 私有目录；不提供旧普通 Agent 业务目录接管命令。中心镜像更新不会自动更新已安装 Agent、授权主机能力或操作业务数据。执行器维护保留审批、摘要、健康确认、程序回退及 unknown 栅栏，见[运维手册](../../docs/operations.md)。

SDK 直接向中心 endpoint 上报，不经过 Agent 接收或配置代理。内外网入口配置见[中心入口发现](../../docs/center-endpoints.md)。

## 主机 IP 与可信反向代理

Agent 注册/心跳采集本机网卡地址，主机管理区分 SSH 地址、内外网服务 IP 与平台观测来源。服务地址由当前 Agent 的有效网卡快照或人工修正提供；没有有效来源时明确不可用，不根据 IP 合并主机。

中心默认使用 TCP 对端地址。反向代理部署时，在 `.env` 将 `LIGHTMONI_TRUSTED_PROXIES` 设置为实际受控代理的 IP/CIDR，多个用逗号分隔；代理应覆盖或追加真实连接来源到 `X-Forwarded-For`。只有直接对端受信才从右向左剥离已知代理，取第一个非受信来源；缺少或无效链显示“来源待发现”，无效信任配置拒绝启动。平台观测地址不代表公网可达地址。

## 同基线程序回滚

在根目录创建本地 `compose.rollback.yaml`，将镜像设为已验证、使用相同存储基线的固定标签，再执行：

```sh
docker compose -f compose.yaml -f compose.rollback.yaml pull lightmoni
docker compose -f compose.yaml -f compose.rollback.yaml up -d --no-build --wait
```

恢复仓库版本时省略覆盖文件。程序回滚保留当前数据；历史开发镜像不属于该回滚范围。不要使用 `down -v` 进行更新或密码恢复。

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
