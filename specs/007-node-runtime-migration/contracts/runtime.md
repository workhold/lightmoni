# Runtime contracts

## Public boundary

所有既有 `/api/v1`、`/v1`、`/downloads`、公开 OAuth/告警回调、SSE、Agent CLI/config 和节点轮询路径及 JSON/protobuf 语义沿用旧实现。以旧代码路由清单生成覆盖矩阵，不创造 `501`、空数据或代理 Go 的完成替代。

## Internal TypeScript boundary

`runtime/src/shared/types.ts` 定义模块唯一接口：

- `DB` 提供 `exec(sql)`、`run(sql,...params)`、`get<T>(sql,...params)`、`all<T>(sql,...params)`、`transaction<T>(()=>T)`，同步事务不可跨 await；`close()` 关闭。
- `Router` 提供 `get/post/put/delete/patch(path,handler,options?)`，路径如 `/api/v1/agents/:id`；handler 接收 `Context`。`options.public=true` 明确公开，其余由统一认证中间件保护。
- `Context` 有 `req/res/params/url/user/signal`；`body<T>()` 有界解码 JSON，`raw(limit?)` 读原始正文，`json(value,status=200)` 输出，`error(status,message)` 抛安全错误。SSE 可写原生 res。
- `Dependencies` 有 `db/router/query/cat/ch/reader/auth/externalURL/encrypt/decrypt/now/logger`。`query(request,signal?)` 与旧 QueryResponse 同形；`cat.list(signal?)` 与目录同形。`auth.requireAdmin(ctx)`、`auth.validateKey(ctx,table?)` 与原角色/表范围一致。
- `Module` 有 `start?()`、`close?()`；`registerX(deps)` 注册模块并返回生命周期对象，核心入口统一启动和退出。

业务类型使用旧字段 snake_case，灵活 JSON 类型用于历史 body 兼容，BigInt 不直接暴露 JSON。响应错误 `{error:string}`，秘密和远端响应正文不公开。每模块自己声明业务表的兼容初始化，shared 库由 root 拥有。

Agent 模块独立导出 CLI execute(args) 和 createAgent(config)，不依赖 server 模块；允许复用 shared OTLP、DB、精确 JSON、原子文件、错误分类。runtime 包统一构建，CLI 用 server/main.js 与 agent/main.js。
