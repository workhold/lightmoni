# LightMoni + ClickHouse

这套配置同时启动主服务和 ClickHouse，适用于没有现成数据库的部署。主服务继承根目录的 `compose.yaml`，数据库连接固定使用 Compose 网络中的 `http://clickhouse:8123`；本目录的 `.env` 独立于根目录配置。

从仓库根目录运行：

```sh
cd deploy/with-clickhouse
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，填写 `LIGHTMONI_CH_PASSWORD`。可以运行 `openssl rand -hex 24` 生成密码，将结果填入该变量；主服务和 ClickHouse 共用这份账号配置。按部署环境修改 `LIGHTMONI_PORT` 和 `LIGHTMONI_EXTERNAL_URL`，然后启动：

```sh
docker compose config --quiet
docker compose up -d --build --wait
```

打开 `LIGHTMONI_EXTERNAL_URL` 对应地址创建第一个管理员。ClickHouse 健康检查通过后才启动主服务；ClickHouse 的 HTTP 和原生 TCP 端口均不映射到宿主机。只有 LightMoni 的 HTTP 端口对外提供服务。

如果使用已发布镜像，将 `LIGHTMONI_IMAGE` 改为对应仓库地址与固定版本，再运行：

```sh
docker compose pull lightmoni
docker compose up -d --no-build --wait
```

从仓库根目录操作时，显式指定本目录的文件：

```sh
docker compose --env-file deploy/with-clickhouse/.env -f deploy/with-clickhouse/compose.yaml up -d --build --wait
```

`lightmoni-state` 保存 SQLite、加密主密钥和运行队列，`lightmoni-telemetry` 保存 ClickHouse 数据。更新镜像或停止容器时保留这两个卷：

```sh
docker compose up -d --build --wait
docker compose logs -f --tail=100
docker compose down
```

备份时同时保存 `.env` 和两个数据卷；恢复时使用同一组 SQLite 状态、主密钥及 ClickHouse 数据。`down -v` 会删除持久卷，仅在明确清空实例时使用。

两种 Compose 是替代部署方式，默认项目名均为 `lightmoni`。沿用原来的 `deploy/server/compose.yml` 部署时，将旧根目录 `.env` 的配置搬到本目录，把 `CLICKHOUSE_PASSWORD` 改名为 `LIGHTMONI_CH_PASSWORD`，保持原项目名和密码。两个持久卷仍使用原来的 `lightmoni_lightmoni-state` 与 `lightmoni_lightmoni-telemetry` 名称；已有部署使用自定义项目名时继续使用该名称。
