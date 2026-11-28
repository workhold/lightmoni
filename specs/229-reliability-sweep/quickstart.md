# 联调步骤

1. 用测试密码执行根 Compose 和源码覆盖的 `docker compose config --quiet`，核对两个中心镜像的平台与标签。用独立项目名、回环端口和隔离数据卷运行已发布中心，检查 `/healthz`、初始化入口与 ClickHouse。
2. 运行 `npm run version:check`、`npm run typecheck` 和 `npm run build`。构建产物用于浏览器和本机联调。
3. 运行 `node web/test/reliability-ui.mjs`。验证普通 HTTP 页面、活动预检与部署、时间线切换，以及目录故障和两类断线恢复。
4. 运行 `cd runtime && node --import tsx --test --test-concurrency=1 test/assistant.test.ts test/service-deployments.test.ts test/platform-status-truth.test.ts`，再运行 AI worker、SDK 和受影响前端测试。
5. 用隔离真实 ClickHouse 和本地兼容测试模型执行首次启动、助手对话及只读查询，记录已执行的验证与限制。
