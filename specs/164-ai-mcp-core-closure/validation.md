# SDD 164 验证记录

验证日期：2026-11-14。基线 `main@eb1690b`。本切片没有修改业务运行时或工具定义，只增加收敛 SDD、可复现隔离验收脚本、脱敏证据和文档。

## 最终验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| E2E 1：真实 Codex 读取与越权拒绝 | 通过 | [summary.json](evidence/summary.json)；`log_app` 返回 3 条真实 `core-e2e-service` 日志；受限 PAT 返回 `resource_not_found` |
| E2E 2：静默提案→Web 审批→生效→回读 | 通过 | proposal `e4cae603d10917f557a04e14bb94f72e`；silence `beaef3873e5a9d0df4de314c6c32768b`；Web Apply completed，Codex 回读 version |
| E2E 3：任务派发→Web 审批→真实 helper→回执→回读 | 通过 | [native-run.json](evidence/native-run.json)；run `8ed83756-db0b-4850-93a7-17cbfaf5c68b` 为 succeeded/exit_code=0，Codex 回读一致 |
| 恢复：客户端断连/新进程幂等重放 | 通过 | 两个 Codex 进程返回同一 proposal `9e37793e-d15c-4740-82cc-f63648700a48`；第二次 `idempotency_replayed=true`，只审批/执行一次 |
| 核心 Capability/MCP/提案/调度定向回归 | 161/161 通过 | `/tmp/lightmoni-core-targeted-final-main.log` |
| Runtime 全量 | 1882 项：1840 通过、35 跳过、7 个当前 main 失败 | `/tmp/lightmoni-core-runtime-final-main.log`；不宣称全量通过 |
| 全仓 typecheck/build | 通过 | 构建期间仅有既有 Web 依赖警告；最终复测记录于 PR |
| 秘密扫描与清理 | 通过 | 实际秘密值未出现在保留的 JSONL/消息中；仓库仅保存脱敏证据，临时 VM/容器/进程已清理 |

失败位于 `agent-host-admission`、`application-install`、`application-list-filter`、`machine-service-addresses`、`machine-terminal`、`managed-machines`、`node-lifecycle`。其中两个应用状态失败随当前 main 引入；本分支相对 `main@eb1690b` 无 runtime/ai-runtime/web/sdk 代码差异，不将这些失败隐藏为通过。

## 客户端与环境事实

- 客户端：Codex CLI `0.167.0-alpha.4.1`，Streamable HTTP MCP `2025-11-25`，PAT Bearer；越权用独立受限 PAT。模型由现有 custom provider 提供，不记录供应商秘密。
- 环境：隔离 ClickHouse `26.8.37.168`；Debian 13 arm64 Linux Agent/helper；Node `22.23.4`；helper 使用签名任务通道，业务脚本以 `lightmoni-agent` UID/GID 1001 执行。
- Web 审批走真实管理员 session 和现有 API。环境 setup 使用原生 enrollment/executor 预约，不构成 Agent 首装或生产部署验收。
- 初次环境尝试中的镜像下载、挂载、Alpine 权限和 PAT 过期均在 harness 中修正，不作为业务通过证据；最终结果只引用最后一次真实成功链路。

## 未完成与边界

- 未执行 Claude、真实 OAuth 浏览器矩阵或生产环境验收；本切片只声明上述 Codex/PAT/隔离范围。
- 不新增服务主体、普通程序 OpenAPI、无人自动化、全领域开放、Agent 后续生命周期或模型网关。
- 服务部署、运维动作和 Agent 首装保留原生实现与自动化证据，但没有借本切片宣称真实生产 E2E。
- Goal 的 PR 合入条件仍需用户授权；未合入时只能报告实现与验证完成、等待评审。
