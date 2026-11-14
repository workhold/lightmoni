# SDD 162 验证记录

验证日期：2026-11-14。范围为 Slice 5 的独立服务主体与固定只读自动化，开发基线为 `main@5076f64`。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 全领域 Capability、MCP、OAuth、路由与安全定向回归 | 148/148 通过 | `/tmp/lightmoni-service-principal-targeted-final.log` |
| `npm --prefix runtime test` | 1882 项：1842 通过、35 跳过、5 失败 | `/tmp/lightmoni-service-principal-runtime-final.log`；失败集合与既有基线一致 |
| `npm --prefix ai-runtime test` | 71/71 通过 | `/tmp/lightmoni-service-principal-ai-runtime.log` |
| `npm --prefix sdk/typescript test` | 28/28 通过 | `/tmp/lightmoni-service-principal-sdk.log` |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-service-principal-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 本地链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或凭据模式 |

全量五项失败仅位于既有 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle` 用例，不宣称 runtime 全量通过。

## 行为证据

- 独立服务 ID 不写入 `users`，Principal 显式记录 `subject_type=service` 与 `owner_user_id`；审计和限流使用服务 ID，旧审计记录迁移后默认 `user`。
- 管理员 Web API 可创建、查看和撤销服务主体；Owner 隔离生效，明文服务 Bearer 只在创建响应出现，管理摘要无 token 明文或 hash。
- 官方 MCP TypeScript SDK fixture 与普通无 Cookie HTTP 使用同一服务策略；发现、OpenAPI 和调用仅包含授权的 capability_id/name/version。
- 只有 `read + center_read`、R0/R1 且 MCP/HTTP 曝光的描述符可授权。propose、直接执行、未授权能力、版本漂移、固定输入不符和 Host 越界均失败关闭。
- 输入固定子集支持递归对象匹配，数组必须整体匹配；未固定字段继续受原 Schema、Scope、Host 和安全投影约束。
- 并发 6 个请求、预算 2 的 fixture 仅 2 个成功、4 个返回 `automation_budget_exhausted`；发现与拒绝请求不扣预算，接纳后的领域失败不退款。
- 服务/grant/token 撤销、到期、Owner 降权或停用均使新请求和旧 Principal 失效；现有 PAT、OAuth、Web、内部助手及稳定 grant 回归通过。
- 未新增能力定义，现有 54 个工具的名称、Scope 和响应保持兼容；服务主体管理 API 不是 MCP 工具。

## 自审发现与修正

1. 发现 SDD 161 的能力 HTTP 在真实 Router 中仍强制 Web Cookie，原测试 mock 未覆盖无 Cookie Bearer。已改为可选认证：Bearer 独立校验，Web 会话继续由 Auth 解析并检查写请求 Origin，未认证请求失败关闭。
2. 首轮回归发现无 MCP 部署只在 `router.auth` 配置会话的兼容问题，已保留 `router.auth` 回退并复测通过。
3. 自审将稳定 capability_id 加入持久规则及每次发现/调用核对，避免同名工具未来复用造成能力漂移。

## 未验证与剩余范围

- 未执行真实 Codex/Claude 客户端矩阵、生产普通程序兼容矩阵或生产业务 E2E；官方 SDK 与 HTTP fixture 只是开发证据。
- 当前只有服务主体管理 API，未新增前端管理页面；未实现策略编辑、轮换、OAuth client credentials 或身份联邦。
- 服务主体写提案持续授权、审批/领取/启动复验、直接 execute、远程探测和其他高风险自动化不属于本切片。
- 网站、容器、备份、DNS、证书、Agent 后续生命周期及真实业务闭环仍需后续独立 SDD。
