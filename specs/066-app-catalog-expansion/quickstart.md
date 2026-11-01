# Validation Guide

1. `npm --prefix runtime run typecheck` 与 `npm --prefix web run typecheck`。
2. `cd runtime && node --import tsx --test --test-concurrency=1 test/application-catalog.test.ts test/application-install.test.ts test/platform-clusters.test.ts test/platform-store.test.ts test/operations-platform.test.ts`。覆盖参数负例、端口、脱敏、实际 HTTP/SQLite 和旧安装回归。完整 runtime 回归使用 `npm --prefix runtime test`。
3. `cd runtime && node --import tsx test/fixtures/verify-catalog-compose.ts`。调用真实 Agent renderManifest，对全部 27 个新增配方执行 `docker compose config --quiet`，不拉取镜像。
4. `cd runtime && LIGHTMONI_CATALOG_LIVE=1 node --import tsx test/fixtures/verify-catalog-live.ts`。需要 Docker；使用临时项目、随机 loopback 端口和测试凭据，实际 Agent 安装 DBX、验证登录/连接持久化及初始化容器，最后清理本轮容器、卷和网络。
5. `cd runtime && LIGHTMONI_OPS_QA_PORT=19966 node --import tsx test/fixtures/cluster-ui-server.ts`；另一个终端 `cd web && LIGHTMONI_DEV_API_URL=http://127.0.0.1:19966 npm run dev -- --port 5196`。`cd web && node src/app/ops/verify-catalog-ui.mjs`（可用 `LIGHTMONI_CATALOG_UI_URL` 指定基址），验证中英文、390/1440px、深浅色、减少动态效果和安装参数。完成后关闭临时服务。
6. 系统设计在 docs/system-design.md 第 66 节；Doca 保存后按最新 seq 回读新增章节和全部 33 个原生图，详见 evidence/doca-readback.json。
7. validation.md 区分配置验证、真实容器、受控回执与未覆盖环境；不能将 Compose 校验称为全部应用真实业务部署通过。
