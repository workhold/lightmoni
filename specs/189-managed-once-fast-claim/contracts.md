# SDD 189 契约

- `managed-once --job-id <id>` 的命令行和中心 API 保持不变。
- 单次进程在 `jobs/claim` 前继续调用执行器 `heartbeat`，并应用中心返回的策略；不调用 `observations/targets`、`observations/batches` 或 Docker 应用采集。
- 常驻 helper 仍调用 `observeOnce()` 并维护观测队列；该路径不领取中心 SSH 单次作业。
- 作业状态、租约续期、签名、回执和人工核对接口保持不变。
