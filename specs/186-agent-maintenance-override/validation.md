# SDD 186 验证

日期：2026-11-19。

- 历史 `unknown` 任务中心、Agent 作业和提权作业的精确快照与新增/运行中任务拒绝：`machine-maintenance.test.ts` 通过。
- 升级计划的强制入口、远端锁与新任务复核、非交互会话拒绝：`machine-agent-updates.test.ts` 通过。
- 卸载计划的强制入口、远端锁与新任务复核、旧未知任务后续核销后的只读结果核对：`managed-machines.test.ts` 通过。
- 三组相关测试共 187 项通过；`npm run build`、`npm run typecheck`、`npm run version:check`（46 项）、`docker compose config --quiet`、`git diff --check` 均通过。
- 架构影响：Agent 生命周期的中心任务栅栏增加审批范围内的精确历史未知任务例外；已更新 `docs/system-design.md` 第 28.4 节。凭据边界、远端锁和派发协议未改变。

## 合入与镜像

- PR [#259](https://github.com/workhold/lightmoni/pull/259) 已合入 `main`，合并提交为 `1900309524e56dea998a5c341ae3d9d41ae624c5`。
- 从该提交构建 `linux/amd64` 镜像，固定标签为 `docker.heyphp.com/lightmoni/lightmoni:v0.1.7-20261119-082000-amd64`；`latest` 同步发布。两者推送 digest 均为 `sha256:e5eeab2f54e9dc8f267589bf21eff2a20e8a58b8bf08d5093ed9073b30c02c2a`。镜像架构、OCI revision、内置 Agent 包与网页入口已回读。

## 生产中心

- 切换前在生产机 `/root/lightmoni-upgrades/20261119-0830-force-maintenance` 留存 Compose、运行配置、主密钥及 SQLite 在线备份；目录权限为 0700，文件权限为 0600。运行凭据未进入仓库或本记录。
- SQLite 备份可只读打开，回读 158 张表及 1,001,480 页；对这份约 3.9 GiB 的快照进行全量完整性检查和 5 分钟限时的 `quick_check(1)` 均未在维护窗口内完成，故不宣称本次快照已通过全量完整性校验。上一版切换前另有完整性检查为 `ok` 的独立快照。
- 首次 `docker compose up --wait` 在数据库备份完整性扫描占用磁盘期间超过健康检查窗口，自动回滚了 Compose 标签。旧镜像随后恢复健康，公网 `/healthz` 为 200。停止长时间运行的全量扫描后，使用已拉取且 OCI revision 匹配的固定镜像重新切换；新中心和 ClickHouse 均为 healthy，`docker compose config --quiet` 通过。
- 公网 `/healthz` 为 HTTP 200，未授权访问 `/api/v1/machines` 为 HTTP 401。

## `zz-bj-1` Agent 实际升级

- 平台交互管理员生成强制升级计划，目标 0.1.7 amd64、发行 SHA256 `5b289c9e1f17085b92eaacd7a859bd3a57ea2eb480a3b55692441bc92acf0fa7`。计划固定旧 `inspect` 操作的 `task_run`、`agent_job`、`privileged_job` 三条 `unknown` 记录，远端只读检查通过。
- 审阅后执行的操作 ID 为 `21c481f7d41788f2999da0b702899f89`，平台状态 `succeeded`。心跳报告新 boot ID `1b20ccfd-adda-4dcc-a029-92ad98b225e2`、发行 0.1.7、source revision `1900309524e56dea998a5c341ae3d9d41ae624c5` 和上述包摘要；目标机 Agent 与 helper 服务均 active，Registry 容器仍在运行。
- 旧任务中心记录仍为 `unknown`，未因强制升级改写审计结果。
