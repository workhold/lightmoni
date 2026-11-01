# LightMoni + ClickHouse（兼容部署入口）

根目录现在默认同时启动中心与 ClickHouse；本目录继续保留，两个服务均继承根配置。已有实例继续使用本目录 `.env`、原项目名与原卷名即可。

本目录 [`.env.example`](.env.example) 包含监听地址、宿主端口、外部访问 URL 和数据库配置。通过 `LIGHTMONI_PORT` 修改宿主端口时，同步修改 `LIGHTMONI_EXTERNAL_URL`；容器内部端口固定为 8080。完整变量表和 18080 端口示例见 [根 README](../../README.md#docker-compose-部署)。

```sh
cd deploy/with-clickhouse
cp .env.example .env
chmod 600 .env
# 编辑 .env，填写 LIGHTMONI_CH_PASSWORD，并修改端口和域名。
docker compose config --quiet
docker compose pull
docker compose run --rm --no-deps --entrypoint lightmoni-admin lightmoni init --name admin
docker compose up -d --no-build --wait
```

初始化只用于空用户库；已有实例跳过该步。密码按无回显提示输入。中心镜像从根 Compose 直接继承 `docker.heyphp.com/lightmoni/lightmoni:20261101-a1292cf`，无需设置 `LIGHTMONI_IMAGE`，旧环境中的该值也不再覆盖镜像。支持 Linux amd64/arm64；两端共用 `LIGHTMONI_CH_USER/PASSWORD`，中心连接 `LIGHTMONI_CH_URL=http://clickhouse:8123`，数据库端口不向宿主机开放。

更新时先在仓库执行 `git pull --ff-only origin main`，再从本目录执行 `docker compose pull lightmoni` 和 `docker compose up -d --no-build --wait`。重置管理员执行 `docker compose exec lightmoni lightmoni-admin reset-password --name admin`。源码构建执行 `docker compose build lightmoni` 和 `docker compose up -d --no-build --pull never --wait`。

`lightmoni-state` 保存 SQLite、主密钥和队列，`lightmoni-telemetry` 保存数据库。备份时配套保存 `.env` 和两个卷；`docker compose down` 保留卷。两个 Compose 入口默认项目名均为 `lightmoni`，应选择一个入口并沿用项目名。历史 `deploy/server/compose.yml` 迁移时把 `CLICKHOUSE_PASSWORD` 改为 `LIGHTMONI_CH_PASSWORD`，保持密码和卷名。

详细说明见 [根 README](../../README.md#docker-compose-部署) 和 [管理员操作](../server/README.md#管理员初始化与密码恢复)。
