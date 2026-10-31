# SDD 047 验证记录

验证日期：2026-10-30。范围为 `feat/platform-mcp-service` 相对 `main` 的平台 MCP 首期实现。未部署生产、未升级 Agent、未操作用户主机；外部客户端实测使用本机内存测试平台、临时 PAT 和只读主机授权，验证后已撤销。

## 自动化检查

| 检查 | 结果 | 覆盖或说明 |
| --- | --- | --- |
| `npm --prefix runtime test` | 528 项；511 通过、17 跳过、0 失败 | 全量后端回归，含本轮 24 项 MCP 测试；跳过项不计作通过 |
| MCP 四组针对性测试 | 24/24 通过 | 凭据与授权、OAuth、能力层、官方 SDK 传输 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | TypeScript SDK、runtime、ai-runtime、web；存在 AntD 常规 bundler 警告 |
| `web/src/app/verify-mcp-access.mjs` | 6 组通过，页面错误 0 | Mock API 的令牌一次显示、显式授权、重开默认值、登录续接、撤销、取消、无效请求、中英文和 390px 布局；不代表真实后端联调 |
| 独立安全复核 | 无剩余阻塞项 | 提案及幂等回读的执行详情必须另有 `executions.read`；无该 scope 只返回 ID 引用 |
| 依赖审计对比 | 未新增 advisory package | 基线与当前均为 4 个既有包：`@earendil-works/pi-coding-agent`、`nodemailer`、`systeminformation`、`undici`；不声称仓库没有已知依赖告警 |

新增自动化测试位于 `runtime/test/mcp-{access,oauth,capabilities,transport}.test.ts`。覆盖不同凭据拒绝、scope/角色/主机范围、schema 拒绝、安全投影、提案审批前与 Agent claim 前的授权复验、稳定业务键、刷新重放、Origin/大小/深度/速率/并发、握手/工具发现/调用及断连。

## 真实客户端

| 客户端 | 结果 | 验收边界 |
| --- | --- | --- |
| Claude Code 2.1.153 | 通过 | 实际自然语言回合经 PAT 调用 `lightmoni_hosts_list`，返回测试主机；退出码 0，平台有对应允许调用审计 |
| Codex CLI 0.165.0-alpha.1.2 App Server | 通过 | 实际 App Server `mcpServerStatus/list` 发现工具，`mcpServer/tool/call` 查询测试主机；工具无错误 |
| Codex 同版本自然语言 `exec` | 未完成 | 模型服务网络重置/超时，不能算 MCP 自然语言完整回合通过 |
| Codex / Claude OAuth 浏览器登录 | 未验收 | code、PKCE、refresh、replay、撤销由服务端 HTTP 测试覆盖，仍需真实客户端互操作验收 |

实测结果摘要见 [client-validation.json](client-validation.json)。接入配置见 [MCP 接入指南](../../docs/mcp.md)；Codex OAuth 配置已对照 [官方文档](https://developers.openai.com/codex/mcp) 核对，不能由此推断所有客户端版本兼容。

## 架构与文档

本轮改变中心的能力分发、外部凭据与 OAuth 边界、MCP 传输和任务提案来源，因此属于架构变更。

- 仓库：`docs/system-design.md` 第 14.4、25 节与 `docs/platform-mcp.md` 当前实现及第 16 节，新增接入指南 `docs/mcp.md`。
- [Doca 系统设计](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已由 seq 806 更新至 807：6 块更新、8 块新增，文本/链接/顺序已回读，516 个无关块及原 22 幅原生图的节点和连线保持不变。
- [同步证据](doca-sync.json) 记录回读；未进行 Doca 浏览器视觉验收。
- 本期只把首批能力接入共享 Dispatcher，任务执行索引是原生 task run 的投影；不代表其他领域已全部统一，也不改变 SDK 独立直报或 Agent 控制协议。

链接、锚点、图结构与秘密扫描结果见 [document-checks.json](document-checks.json)。

## 2026-10-31 主干集成复验

本次以 main `0d81f40` 为基线，解决五处冲突；完整保留主干调度、参数/工作目录、并发、队列、自动重试及稳定外部授权继承。修复 MCP 关闭后助手 fallback 可能放行外部提案的问题，缺少任一授权 hook 返回 503 且不排队。移除模板工具，主机观测只读取当前 Agent，执行 review_url 打开主机执行记录。

- runtime 全量 715 项：694 通过、21 跳过、0 失败；相关 132 项全通过，最终 HTTP 拒绝断言追加后相关 37 项全通过。
- ai-runtime 71/71、TypeScript SDK 22/22 通过。SDK 首次有一个既有 fake-fetch 测试因未引用的 AbortSignal 超时而被取消；仅修正测试计时器、保留 TimeoutError 语义后全部通过，未改 SDK 运行代码。
- 全仓类型检查、构建、差异检查通过；主干既有依赖版本不升级，合并 lockfile 在隔离目录通过 npm ci dry-run。
- MCP 页面六组 Mock API 验收通过，页面异常 0；已查看 1440px 管理页、390px 布局截图。它不代表真实客户端 OAuth 联调。
- [集成证据](integration-validation.json) 与 [UI 报告](evidence/main-integration/report.json) 记录实际范围。上述 seq 806→807 为此前实现的历史同步，不能代表本次已同步；本次 Doca 由主代理合并 #21 后局部更新并回读，完成前保留待办。
