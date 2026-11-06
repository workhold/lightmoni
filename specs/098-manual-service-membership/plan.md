# 实现设计

基于 GitHub `origin/main` 的 `bc0418f`，在独立工作区实现；不修改现有发布工作目录。

1. `runtime/src/ops/availability.ts` 将身份/人工期望状态与健康状态分离。手动已就绪成员持久保留并按 `retained` 展示，健康失败不执行预算撤流；托管预算逻辑保持。
2. `runtime/src/ops/cluster-workloads.ts` 对账中的手动修复返回漂移状态；保留只读 inspect、人工操作和授权网关配置传播。避免因 gateway inspect 的不健康或配置漂移自动 force recreate。
3. `web/src/app/ops/InstalledApplications.tsx` 为手动保留成员显示准确的中英文状态，区分托管自动替换。
   手动网关的网站回执在现有 status_json 中保留最后成功发布证据，失败继续可见；DNS 只使用当前发布配置仍允许的成功证据。
4. 增加实际 HTTP/SQLite 控制器和 DNS 厂商 fixture 回归，覆盖离线、失败、意外停止、重启后持久状态、人工撤销与手动对账；复用托管预算/切换回归。
5. 更新系统设计第93章与 Doca 原生段落，按最新版本回读；记录相关测试、类型检查和构建证据。

不新增自动迁移、自动重建、生产发布或生产 DNS 操作。本轮修复的测试 DNS 为隔离 fixture，不能据此声称线上已恢复。
