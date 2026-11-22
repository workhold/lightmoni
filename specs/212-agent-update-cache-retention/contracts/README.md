# 契约

## Agent 更新缓存回收（`AgentReleaseCatalog.prune`）

- 输入：`retained: Set<string>`（必须保留的 SHA256 引用）、`keep = 8`（按 mtime 保留的最新文件数）。
- 仅处理缓存目录内 `^[a-f0-9]{64}$` 命名的普通文件；点前缀 staging 文件、子目录、符号链接跳过。
- 删除条件：既不在最新 `keep` 个之内、也不在 `retained` 中；删除同时清理进程内哈希缓存。
- 触发时机：模块启动（catalog 构造后）与维护计划成功入库后（事务提交外）；失败静默，不影响计划创建与启动。
- 保留集合来源：活动状态（`awaiting_approval/running/verifying/unknown`）维护计划 `plan_json` 中的全部 64 位十六进制值。
- 固定（`pin`）、校验（`verify`）与下载服务路径不变；审批不可变字节语义不变。
