# 验收复现

在 runtime 目录运行：

```sh
npm run typecheck
node --import tsx --test test/application-catalog.test.ts test/application-logos.test.ts test/platform-clusters.test.ts
LIGHTMONI_CATALOG_EVIDENCE=../../../specs/094-catalog-search-storage/evidence node --import tsx test/fixtures/verify-catalog-compose.ts
```

预先拉取配方中的官方镜像（含固定摘要）后，在 runtime 运行以下命令。脚本只在临时目录创建权限0600清单，并用唯一 Compose 项目、本机动态端口、独立网络/卷验证；结束移除测试容器、网络、卷与临时凭据。

```sh
node --import tsx test/fixtures/verify-search-storage-live.ts
```

可用 LIGHTMONI_CATALOG_SMOKE_IDS=meilisearch,searxng,rustfs 限定实测范围。真实冒烟覆盖生产鉴权与索引检索、SearXNG 配置和检索格式、签名 S3 桶/对象读写及控制台、Firecrawl 五服务和 example.com Markdown 抓取；未执行部分不能由静态 Compose 检查替代。

浏览器：启动 runtime/test/fixtures/app-install-ui-server.ts（LIGHTMONI_INSTALL_QA_PORT=19946）以及 LIGHTMONI_DEV_API_URL=http://127.0.0.1:19946 的 web 开发服务（5196），再从 web 运行 node src/app/ops/verify-catalog-ui.mjs。该后端使用真实 HTTP / SQLite / 加密和显式 QA 管理员；不连接远端 Agent，DBX 保存与待执行记录不代表生产部署完成。
