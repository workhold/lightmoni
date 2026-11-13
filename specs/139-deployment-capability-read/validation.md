# SDD 139 验证记录

验证日期：2026-11-14。范围为 Slice 2 服务与部署只读。分支 stacked 在 SDD 138 的 `52a88e5` 上；main 为 `1c3b0e4`，PR #192 在开发时仍 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 核心、描述符、遥测、告警、日志/Trace、服务部署、MCP 与助手定向测试 | 144/144 通过 | `/tmp/lightmoni-deployment-targeted.log` |
| `npm --prefix runtime test` | 1813 项：1773 通过、35 跳过、5 失败 | `/tmp/lightmoni-deployment-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-deployment-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 行为证据

- 服务列表、详情 targets/releases、部署分页/详情/事件均来自真实 ServiceDeploymentStore 和 SQLite 记录，无新增状态机分支。
- 部署读取返回 awaiting_approval、operation_id 和真实事件，不将计划或排队改成成功；无 approve/rollback/upload/execute 工具。
- 无 Scope、有限主机授权和成员会话均不能读取该管理员领域；直接 invoke 同样拒绝。
- 内部 list_services/get_service_deployment/get_service_deployment_events 保留原输出形态，新 list_service_details/list_service_deployments 可用，注册无重复，审计 source=assistant。
- 官方 MCP SDK 发现五个新能力，读取真实 targets/releases、部署状态和事件，outputSchema 校验通过。
- 告警模块启用时工具总数为 25。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。部署/回滚提案、审批、制品上传和遥测核验写操作属于后续 Slice 3；运维、主机/Agent 等领域仍待迁移。
