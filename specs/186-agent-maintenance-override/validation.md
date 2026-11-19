# SDD 186 验证

日期：2026-11-19。

- 历史 `unknown` 任务中心、Agent 作业和提权作业的精确快照与新增/运行中任务拒绝：`machine-maintenance.test.ts` 通过。
- 升级计划的强制入口、远端锁与新任务复核、非交互会话拒绝：`machine-agent-updates.test.ts` 通过。
- 卸载计划的强制入口、远端锁与新任务复核、旧未知任务后续核销后的只读结果核对：`managed-machines.test.ts` 通过。
- 三组相关测试共 187 项通过；`npm run build`、`npm run typecheck`、`npm run version:check`（46 项）、`docker compose config --quiet`、`git diff --check` 均通过。
- 架构影响：Agent 生命周期的中心任务栅栏增加审批范围内的精确历史未知任务例外；已更新 `docs/system-design.md` 第 28.4 节。凭据边界、远端锁和派发协议未改变。
- PR 合入、镜像发布、生产部署和实际主机升级结果另行回填。
