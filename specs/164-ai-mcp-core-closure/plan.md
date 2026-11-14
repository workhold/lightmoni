# 收敛实施计划

1. 固定 main 基线，完成 54 工具矩阵与既有 validation 审计，不增加新工具；将旧范围 WIP 和可选 PR 排除出依赖。
2. 建立临时目录中的隔离 SQLite/ClickHouse/HTTPS 中心、独立管理员/PAT 和 Linux Agent/helper；所有秘密仅存在受保护临时文件，不进入仓库、日志或模型上下文。
3. 用真实 Codex CLI 完成 E2E 1 读取与越权拒绝，保存脱敏 JSONL/结果摘要和原生查询证据。
4. 用真实 Codex + Web 管理 API 完成 E2E 2 静默提案、审批、原生生效与回读。
5. 用真实 Codex + Web 管理 API 完成 E2E 3 派发、签名 helper 真实执行、中心回执与回读；补撤销或断连安全场景。
6. 若发现核心缺口，先更新本 SDD 与 docs/system-design.md 再做最小修复；否则只补验收脚本和证据，不重复开发。
7. 运行相关回归、类型检查、构建与文档检查，更新矩阵、validation 和接入文档，创建面向 main 的 PR，不合并。
