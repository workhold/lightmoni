# SDD 169 发布契约

## 版本事实来源

- 根 `package.json.version` 是唯一语义化版本事实来源，格式为 `x.y.z`。
- `npm run version:check` 必须校验所有登记的平台、Agent、SDK、构建和 Compose 版本点；任一缺失或不一致均非零退出。
- `npm run version:bump -- <x.y.z>` 可从当前版本递增或重复检查同一版本；不得改写 lock 中其他第三方包版本。

## 镜像标签

- 根 Compose 使用 `docker.heyphp.com/lightmoni/lightmoni:v<x.y.z>-<YYYYMMDD>-<HHMMSS>-amd64`，时间为发布编排时的 UTC 时间。
- `latest` 和 `v<x.y.z>-amd64` 只能作为便捷别名，不能替代 Compose 的固定标签。
- OCI `org.opencontainers.image.revision` 必须是实际构建源码的完整 40 位 Git SHA，不能由标签推断。

## 发布边界

- 先合入版本 PR，再从 `main` 构建；不直接使用 GitHub 流水线，不直接 push `main`。
- 本次仅推送 amd64 平台镜像。镜像内仍可包含双架构 Agent 安装包，不将其误称为已发布 arm64 平台镜像。
- 版本检查通过不等于运行验收完成；推送前必须检查容器健康和关键版本/发行文件，推送后必须回读 digest。
