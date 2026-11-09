# 验收记录

日期：2026-11-08。

- Web `npm run typecheck`：通过。
- runtime `node --import tsx --test test/application-catalog.test.ts test/application-install.test.ts`：13 项通过，0 项失败。
- 使用 `catalogInstallation('postgresql', ...)` 检查默认身份与自定义身份：`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` 映射均正确，默认用户名 `lightmoni`、数据库 `app` 保持。
- 复用 `runtime/test/fixtures/app-install-ui-server.ts` 和 Vite，在回环地址执行临时 Playwright 验收：中文/英文 × 1440px/390px 四种组合通过。高级设置折叠时三项可见且只出现一次；默认值、密码遮蔽、自定义输入及展开/折叠后保留通过；无横向溢出，无页面运行异常。
- 中文桌面通过真实 HTTP 安装路由提交自定义三项参数并取得 201；资源可回读，安装响应与回读均不包含测试密码。仅生成夹具中的待执行 Agent 作业，未执行外部 PostgreSQL 容器。
- 其他三个界面组合检查 MySQL 的应用用户名仍位于高级设置，原有分组保持。
- 已查看中文桌面和英文手机截图，字段标签、间距和单列折行正常。截图保存在本地忽略目录 `artifacts/screenshots/specs/114-postgres-install-fields/`，测试密码在截图中遮挡。文本证据见 [evidence/ui.json](evidence/ui.json)。
- `git diff --check`：通过。

## 兼容与架构影响

仅将 PostgreSQL 的现有可选身份参数移到基本表单，API、默认值、校验与凭据处理不变；不会修改已有数据库实例。架构同步不适用：组件职责、控制路径、存储、协议、凭据边界和部署拓扑均不变，因此不改写 `docs/system-design.md` 或 Doca 在线设计。

## 交付边界

此验收仅针对本地代码和隔离夹具；未合并主干、未发版、未部署或修改线上数据库。
