# 验收记录

日期：2026-10-31。应用上游由中心按目标 OpenResty 实例的机器 ID 解析；同机使用 `127.0.0.1`，异机使用原发现地址。沿用现有 Agent 载荷和执行流程。

## 自动化验证

以下 Runtime 检查通过：

```sh
npm --prefix runtime run typecheck
cd runtime
node --import tsx --test --test-concurrency=1 test/platform-website-routing.test.ts test/platform-clusters.test.ts test/platform-nginx.test.ts test/platform-api.test.ts test/platform-reconcile.test.ts test/platform-executor.test.ts
```

共 57 项通过，0 失败、0 跳过。新增两项 HTTP/HTTPS 场景使用真实 HTTP Router、SQLite、Store、Agent job lease 和生产 Nginx 渲染器，双机器/双网关位于同一集群。验证各台网关仅将本机应用端点替换为回环，异机 IPv6 保留方括号；两个命名端口均使用正确宿主端口；manual 应用目标遵循相同规则，显式代理 URL 原样保留；发现 API 与集群预览保留原 IP。两台网关各有独立配置签名，稳定 tick 不重复入队；失去一个健康端点后分别更新，全部失去后仍返回 503。

现有回归同时覆盖跨集群隔离、失效 Agent 身份过滤、端口预留、managed 故障迁移、逐修订发布、冻结域名范围、Nginx 校验和执行器边界。Agent 成功回执为受控夹具；本次未进行真实 Linux OpenResty 网络连通性或生产部署验收，不用配置渲染替代此证据。

## 架构与兼容

请求数据路径发生变化，已更新 `docs/system-design.md` §42.4、§42.5，并同步 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。保存确认后回读目标正文，完整匹配；相关原生图完整块保持一致，8 个节点与 6 条连线均未改变。结构化证据见 [architecture-sync.json](architecture-sync.json)。

不新增配置字段、数据库迁移或 Agent 协议，现有 Agent 继续接收完整配置。中心升级后，旧同机内网上游与新的逐机配置签名不同，下一次调和将发布新配置；无同机后端的网关保持原配置。凭据、权限、域名范围和手工 URL 不变。

提交前已同步远端 `origin/main`；集成到 `5aa5526`（主干新增内容仅为镜像发布与文档）。功能通过 [GitHub PR #39](https://github.com/workhold/lightmoni/pull/39) 交付，未合并、未发布镜像或改动生产配置。
