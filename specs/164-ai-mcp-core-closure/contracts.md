# 核心收敛与 E2E 证据契约

## HLD

内部 AI ─────────────┐
                    ├→ Capability Dispatcher → 原生提案 → 管理员审批 → 原领域执行 → 原生回执
外部 Codex/Claude → MCP ┘                                      ↑
                                                      Web 原业务 API

原生 Store/状态机是事实来源；Capability 与索引只做统一权限适配和安全投影。MCP 不直连数据库、Agent、SSH 或 Apply，模型接入保持薄边界。

## LLD：ID 与恢复映射

- E2E 1：MCP request → invocation_id → 真实 Query/LogRead 结果；越权使用独立 PAT 和明确 Host，保存 detail_code，不保存 token。
- E2E 2：MCP request → capability invocation → alert proposal ID → Web Apply → 原生 silence ID/version → MCP 回读。
- E2E 3：MCP request → task proposal ID → Web Apply → Task Run ID → 签名 helper claim/lease → 原生 result → MCP execution 回读。
- 恢复：grant 撤销、客户端断连或 unknown 均保留原 proposal/run ID；不得创建替代执行或自动重放。

## 证据格式

每项记录：日期、隔离环境标识、客户端名称/版本、模型提供方类型（不记录秘密）、MCP 协议、认证方式、工具与关键输入、原生记录 ID、Web 审批端点、真实状态、断言结果和脱敏日志路径。

不得保存 PAT、Cookie、enrollment/bootstrap/control/data 凭据、私钥、CH 密码、原始 Authorization 头、secret 文件内容或生产数据。临时 env/JSON 秘密文件必须 0600 并在清理时删除；仓库只保存脚本、脱敏摘要和必要原生安全字段。

环境 setup 使用原生 enrollment/executor 服务仅用于准备，不被描述为 Agent 首装验收。被测结果必须由真实客户端、Web 审批和真实进程回执证明；HTTP 200、SDK fixture 或直接数据库写入均不单独构成通过。
