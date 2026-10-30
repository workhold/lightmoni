# Validation guide

1. npm --prefix runtime run typecheck；npm --prefix web run typecheck。
2. npm --prefix runtime test（执行前收敛新增定向测试）；npm --prefix web run build。
3. 在隔离 Linux Docker 节点登记机器池→单容器/Compose 应用→部署→观察实例→托管副本→网站和网关→更新文件/证书→核对版本和健康。
4. 测试专用域登记两 DNS 平台；真实凭据只由运行时注入，ACME 先 staging；三云 CDN 仅在显式测试域验证部署与回读。
5. 浏览器从运维入口创建、保存、刷新读取、修改冲突、查看逐目标失败、深浅主题和窄屏。
6. Doca 定向读/写/最新回读，保留已有图块与无关内容，保存结果到 validation.md。

## 本地页面验收复现

先执行根目录 `npm run build`。页面夹具自行启动并关闭 Vite/HTTP：

```sh
node web/src/app/ops/verify-ui.mjs
node web/src/app/verify-navigation-homepage.mjs
```

真实 SQLite 页面验收使用三个终端；仅启动测试夹具，不使用生产配置或数据库。

```sh
# 终端1（runtime/）: 自动创建临时SQLite和内存密钥，退出删除临时目录。
node --import tsx test/fixtures/platform-ui-server.ts

# 终端2（仓库根目录）
LIGHTMONI_DEV_API_URL=http://127.0.0.1:19933 npm --prefix web run dev -- --port 19934

# 终端3（仓库根目录）
node web/src/app/ops/verify-live-ui.mjs
```

该夹具仅监听 loopback，身份固定 qa-admin，Agent 不可登记、云 fetch 禁用，周期调度不开启。自签密码学、SQLite加密、资源校验、HTTP路由与修订冲突使用真实实现；现场 Docker、有效Agent租约和云协议测试另行执行。完成后 Ctrl-C 关闭前两个终端。测试报告位于 evidence/，截图/录像遵循仓库规则放在忽略目录 artifacts/screenshots/。
