# Compose 镜像选择契约（2026-10-30）

- 根配置 `services.lightmoni.image` 为固定字符串 `docker.heyphp.com/lightmoni/lightmoni:20261030-ddd7426`，不进行 `LIGHTMONI_IMAGE` 插值。
- 兼容部署入口继承根配置；旧 shell/`.env` 中的 `LIGHTMONI_IMAGE` 不参与镜像选择。
- `.env` 继续保存 `LIGHTMONI_CH_PASSWORD`、地址、端口与 `COMPOSE_PROJECT_NAME`，本次不改变其含义或删除现有文件。
- 更新执行 `git pull --ff-only origin main`、`docker compose pull lightmoni` 和 `docker compose up -d --no-build --wait`。镜像拉取本身不重建容器。
- 人工指定历史版本时，通过额外 Compose 文件的 `services.lightmoni.image` 显式覆盖；沿用原项目名、卷与主密钥。旧 `LIGHTMONI_IMAGE` 环境变量不再提供此能力。
- 不修改已发布镜像、远端容器或本地运行实例，不新增架构。
