# SDD 177 验证记录

日期：2026-11-16。仅记录已实际完成的步骤。

## 版本准备与镜像发布

- 版本 PR [#242](https://github.com/workhold/lightmoni/pull/242) 已合入：`npm run version:bump -- 0.1.4` 统一平台、Agent、SDK、MCP 与构建版本，`npm run version:check` 46/46 通过；Compose 固定标签 `docker.heyphp.com/lightmoni/lightmoni:v0.1.4-20261115-165712-amd64`。
- 发布内容：SDD 175（PR #238 同机残留身份修正）+ SDD 176（PR #241 维护车道可观测与 keep_current 出口）。构建源码为 `main@d540ecede2030450ca79efb51d9fb6ae382c7ea6`。
- 从该提交的干净归档本地构建 linux/amd64 中心镜像（Dockerfile 固定 `node:24.15.0-bookworm`；Debian 源经清华镜像并保持签名校验，首次因官方源拉取不稳失败后换源重试成功）。镜像 OCI revision 与源码提交一致。
- 镜像内 `lightmoni-agent_0.1.4_linux_amd64.tar.gz`、`_arm64.tar.gz` 与四种 SDK 归档按 `SHA256SUMS`/`SDK_SHA256SUMS` 逐项校验通过；双架构 Agent release 元数据 `source_revision` 均为上述提交。
- 隔离验收（本机 arm64 ClickHouse + 待验收 amd64 中心容器，独立卷，随机凭据 0600 env，验收后已销毁）：`/healthz` 与首页 200；未认证实例设置与 Agent 发行读取 401；`POST /api/v1/setup` 201；带会话实例设置 200 且 `version=0.1.4`；经 OAuth PKCE 全流程取得 MCP 令牌后 `initialize` 返回 `serverInfo.version=0.1.4`。
- 已推送固定标签与 `latest`，远端回读两者摘要均为 `sha256:50bce520bc9651999aad8c2343886443f6f7508614bb946c991959ac119b219c`；业务 manifest 平台 linux/amd64，另一 unknown/unknown 条目为 BuildKit attestation。
- GitHub Release：`20261116-v014-50bce5`（见发布说明）。

## 生产切换与线上验证

- 切换前发现生产已由上游切换至 `v0.1.3-20261115-164421-amd64`（运行 4 分钟，healthy），而磁盘 compose pin 仍为 v0.1.1（漂移）。备份包 `/root/lightmoni-upgrades/20261116-v013-50bce5-to-v014-preswitch/`：compose.yaml、env、master.key、release.json 与 3.2GB `VACUUM INTO` 快照（integrity ok）。回滚目标改为 v0.1.3 固定标签。
- 生产切换：`docker compose up -d --no-build --wait` 后容器 healthy，镜像为 v0.1.4 固定标签；compose pin 顺带从 v0.1.1 漂移修正为 v0.1.4。`/healthz` 与首页 200（注意：panel.heyphp.com 根路径是 1Panel 拦截页，中心在 moni.heyphp.com）。
- 线上验证（admin 会话）：实例 `version=0.1.4`；5 台主机在线（vchive、zsw-bj-1、zsw-hk8c16g-doca-1、zsw-hk8c8g-3xui-1、zz-bj-1）；4 个应用（小猪绘本、OpenResty、PostgreSQL、系统镜像仓库）全部 active。
- SDD176 改进逐项线上生效：
  - `GET /api/v1/machines/:id/busy` 返回 `{busy:false}`（zsw-hk8c8g）。
  - zsw-hk8c8g 发起升级返回新 409 文案，精确指出生命周期锁未释放并给出处置建议（此前合并为一句的不可行动提示）。
  - 应用实例恢复投影透出 `job_id` 与 `observed_at`（小猪绘本实例 recovery 字段可见），据此定位到 zz-bj-1 阻塞源。

## 管理员操作记录

- zz-bj-1 unknown managed 检查作业（744bb152…，系统镜像仓库 plan）经管理员批准后于 2026-11-16T00:00:10Z 执行 `POST /api/v1/privileged-execution/jobs/744bb1524ae115c3f1ffc97a8c416aea/reconcile`（confirm+reason 已入审计）；决议后该机 `unknown_execution_result` 资源 4→0，恢复循环重跑，小猪绘本实例回到 healthy 且 recovery=in_sync，四应用保持 active。改进 #4 的 job_id/observed_at 投影正是本次定位阻塞源的手段。
- zsw-hk8c8g 生命周期锁 `/run/lightmoni-agent-lifecycle.lock` 待管理员经 moni 平台终端确认无维护进程后清理并重启 lightmoni-agent；随后经中心重发升级（0.1.4）。
