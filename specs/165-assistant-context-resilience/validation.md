# SDD 165 验证记录

## 实现范围

- 内部助手目录按调用来源在能力执行层直接生成摘要，避免完整目录先触发 64KB 上限；摘要上限 12KB，含合法截断状态。MCP 仍返回完整列元数据。
- 助手查询样本上限 16KB，MCP 继续 60KB；单表完整描述与既有行数限制保留。
- assistant 缺少 `$__timeFilter(column)` 时在查询执行器之前返回明确错误，MCP 不增加此限制。
- 已选表直接描述、单表优先、字段核验和有限纠错进入系统/工具指令。
- Mastra 最后一步使用 `toolChoice:"none"` 和空 `activeTools`；四协议 fixture 与单步预算均形成最终文本。

## 通过与证据

- `node --import tsx --test --test-concurrency=1 test/telemetry-capabilities.test.ts test/assistant.test.ts`：**23/23 通过**。覆盖内部目录 12KB、MCP 完整列、完整单表描述、助手 16KB、MCP 60KB、时间宏前置拒绝与真实查询错误透传。
- `npm --prefix ai-runtime test`：**79/79 通过**。其中新增 8 个用例覆盖四协议最后步骤与 `max_steps=1`；既有文本、工具、历史、取消、超时、输出限制、用量与私有 continuation 测试保持通过。
- `npm --prefix sdk/typescript test`：**28/28 通过**。首次沙箱监听 EPERM 后在允许本机临时端口的环境复跑通过。
- `npm run typecheck`：runtime、ai-runtime、web 全部通过。
- `npm run build`：SDK、runtime、ai-runtime、web 全部通过。
- `git diff --check`：通过。无凭据、密钥、生产地址或运行时秘密进入变更。

## 全量 runtime 与基线差异

`npm --prefix runtime test` 完整执行结束，出现以下 5 个失败；相同失败在未修改的 `origin/main`（9807087）独立工作树中逐项复现，非本 PR 引入：

1. `application-list-filter.test.ts`：状态集合缺少既有 `draft` 期望。
2. `machine-service-addresses.test.ts`：读取不存在的 `network`。
3. `machine-terminal.test.ts`：SSH 鉴权清理断言差异。
4. `managed-machines.test.ts`：卸载请求实际 201、既有断言 409。
5. `node-lifecycle.test.ts`：新建计划实际 403、既有断言 201。

本次不修改这些无关领域，也不把完整 runtime 写成全绿。相关文件与新增回归均通过；基线问题应另行立项处理。

## 边界

- 验证使用真实 Node runtime、SQLite、宿主服务与四协议 HTTP fixture；不包含合入后生产发布或真实模型 SQL 质量认证。
- 生产只读诊断得到的 65,430 字节目录是修复动机，不作为新代码的生产验收；新实现由可重复单元/集成测试验证。
- 不自动切换模型协议，不宣称特定网关 Responses 工具兼容已修复。
- 架构影响：不适用。没有组件职责、数据/控制路径、凭据、存储、协议或部署拓扑变化，因此未修改 `docs/system-design.md`。
