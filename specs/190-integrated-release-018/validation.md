# SDD 190 验收记录

日期：2026-11-20（北京时间）。仅记录本次实际执行并回读的步骤。

## 合入与组合检查

- [PR #261](https://github.com/workhold/lightmoni/pull/261)、[PR #263](https://github.com/workhold/lightmoni/pull/263)、[PR #262](https://github.com/workhold/lightmoni/pull/262) 已依次合入 GitHub `main`，最终提交 `c7a7aba8ffbc03482b420245c312cf87fb7b04b7`；合入后无开放 PR。
- 隔离工作树按相同顺序合并无冲突，文件树与最终 `main` 相同；`npm run version:check` 46/46、Runtime 和 AI Runtime 类型检查、Runtime/AI Runtime/Web 构建通过。
- AI Runtime 测试 89/89；相关 Runtime 测试 62 项通过、1 项环境门禁跳过。首次 Runtime 测试因尚未构建 AI Runtime `dist` 而失败，按完整构建顺序补齐后重跑通过。
- `npm audit --omit=dev` 报告 Runtime 2 项 high、AI Runtime 4 项 high。涉及的 `systeminformation`、`undici`、`@mastra/core`、`@modelcontextprotocol/server`、`zod` 与 `@earendil-works/pi-coding-agent` 锁定版本均和本次合入前的 `main` 相同；本次发布未修复这些既有依赖告警。

## 镜像发布

- 从最终 `main` 本地构建 linux/amd64 镜像，OCI revision 为 `c7a7aba8ffbc03482b420245c312cf87fb7b04b7`，容器用户为 `lightmoni`。npm、Node 与 Debian 使用公开镜像源加速下载，仍按锁文件 integrity、官方 Node SHA256 与 Debian 仓库签名验证。
- 固定标签 `v0.1.8-20261119-155555-amd64` 和 `latest` 已推送；远端回读均为 `sha256:54645fa2f564e13b942bb6928107331ed823de8e8ffdd7340f33e16b5aea16e2`，业务 manifest 为 linux/amd64。固定标签重新拉取后镜像修订号仍匹配最终 `main`。
- 镜像内双架构 Agent 与 Go、Python、Rust、TypeScript SDK 文件均通过发布清单 SHA256 校验。
- 隔离 Compose 项目的中心与 ClickHouse 均 healthy；首页、`/healthz` 为 HTTP 200，未认证实例接口为 401。初始化隔离管理员后，实例与 MCP 均报告 0.1.8。专属容器、网络、数据卷及临时凭据文件已清理。

## 生产部署

### 中心切换与备份

- 切换前生产 Compose 位于 `/opt/lightmoni/lightmoni/compose.yaml`，中心镜像为固定标签 `v0.1.7-20261119-082000-amd64`，ClickHouse 为 `clickhouse/clickhouse-server:26.8`。确认中心实际挂载 `lightmoni_lightmoni-state-v2-20261103:/data`，ClickHouse 挂载 `lightmoni_lightmoni-telemetry:/var/lib/clickhouse`；未启用另一个遗留状态卷。
- 在 `/opt/lightmoni/backups/release-0.1.8-20261120` 建立仅管理员可读的备份目录，保存原 Compose、`.env` 与 `master.key`，目录权限 0700，文件权限 0600。停止中心和 ClickHouse 后，分别冷备份状态卷与遥测卷，压缩归档约 11.8 GiB 与 7.79 GiB；两个归档均通过 `zstd -t`。冻结 SQLite 的 `PRAGMA quick_check` 因耗时中止，未取得完整性结论；冷备份归档校验不能替代数据库逻辑完整性检查。
- 对比 Compose 配置，只有中心镜像引用改为 `docker.heyphp.com/lightmoni/lightmoni:v0.1.8-20261119-155555-amd64`；`docker compose config --quiet` 通过。沿用原项目、受限环境、主密钥和两个生产卷。先恢复 ClickHouse，再启动中心；两容器 Docker 健康检查均为 healthy，ClickHouse `SELECT 1` 返回 `1`。中心容器所用镜像修订为最终 `main@c7a7aba8ffbc03482b420245c312cf87fb7b04b7`。
- 中心本地 `http://127.0.0.1:8080/healthz` 与公网 `https://moni.heyphp.com/healthz` 均返回 HTTP 200；生产管理员可登录并访问工作台。旧固定标签和冷备份保留作为回滚依据。

### Agent 与应用核对

- `zz-bj-1` 原 0.1.7 Agent 已离线，主机现场核对确认旧程序、服务、特权执行器与工作进程均不存在；遗留的未知执行围栏阻止原位升级。使用平台“修正 Agent 状态”的审计流程核对并修正 37 条旧记录，未直接修改数据库；历史未知结果仍保留，不作成功认定。旧 Agent 身份与凭据注销，受管主机、SSH 凭据和业务数据保留。
- 使用平台“部署 Agent”重新接入该主机，SSH 预检与分步执行完成，安装回执为“安装完成”。新 Agent 身份为 `13e088cf1054dd2bd1bb48d2538ed13a`；平台显示在线、完整管理、持续心跳、版本 0.1.8 和提交 `c7a7aba8ffbc`。这次是审计修正后的重新接入，并非原位升级。
- 重装后的四个旧应用实例（小猪绘本、OpenResty、PostgreSQL、系统镜像仓库）在平台中仍为“待核实”，显示“自动恢复受阻”。原应用容器、数据库容器、仓库容器与网关容器均仍在目标主机运行，其中小猪绘本与 PostgreSQL Docker 健康检查为 healthy；这只证明容器存在，**不证明平台应用绑定已恢复**。
- 两次自动核验产生未知结果：OpenResty 的只读 `inspect` 执行 `dc7e8377d6c2b2c2bda1c99de3ea1c23` 与小猪绘本的只读 `inspect` 执行 `7d0beb2cddae49a4958f163b8829a722`。现场 `systemctl show` 均显示对应执行单元不存在且 inactive/dead，核对业务容器后使用平台“人工核对结束”记录依据、解除互斥；原结果仍为未知。自动核验随后继续排队并出现取消；“恢复重装后的应用绑定”计划的只读检查因 `machine_execution_locked` 被取消，未修改远端应用数据，也未恢复四个绑定。
- “镜像与仓库”页面仍显示仓库部署“等待应用”，镜像清单查询返回 `cancelled`。仓库容器在目标主机仍运行；平台清单和应用绑定尚未完成验收。后续问题由 [#265](https://github.com/workhold/lightmoni/issues/265) 跟踪：修复自动核验与人工恢复的执行互斥后，重新核对四个应用绑定及私有仓库清单。当前发布验收只覆盖中心和 Agent 版本、健康与入口，不将应用管理恢复标为通过。
