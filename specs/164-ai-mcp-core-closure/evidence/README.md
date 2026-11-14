# SDD 164 核心 E2E 脱敏证据

- [summary.json](summary.json)：客户端/协议/认证、环境、三类 E2E、调用 ID、原生 ID、恢复结果与秘密扫描结论。
- [native-run.json](native-run.json)：最终真实 Task Run 的状态、退出码、时间、marker 和安全输出。
- [client-messages.md](client-messages.md)：真实 Codex CLI 的脱敏最终消息；工具调用与 invocation ID 另由 summary.json 对照。

执行脚本位于 `scripts/e2e/core-mcp-*.mjs`。临时 SQLite、ClickHouse、Linux Agent/helper、HTTPS 代理与 SSH 通道均用于隔离验收，不使用生产数据。环境 setup 的原生 enrollment/executor 预约不构成 Agent 首装验收。

原始 Codex JSONL 仅保留在临时目录用于核验；仓库不保存 PAT、Cookie、密码、enrollment/bootstrap/control/data 凭据、私钥或 Authorization 头。清理时停止中心、SSH、容器和独立 `core-e2e` VM，并删除临时秘密文件。
