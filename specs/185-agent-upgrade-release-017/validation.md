# SDD 185 验证记录

日期：2026-11-18 至 2026-11-19。仅记录已完成并回读的步骤；`zz-bj-1` Agent 升级仍待完成。

## 版本准备

- PR #256 已合入 `main`，合并提交为 `1f3d61446fa772d0829d36ef5f95d1b7353d30b2`。
- 版本脚本统一平台、Agent、SDK、MCP 为 0.1.7；Compose 固定标签为 `docker.heyphp.com/lightmoni/lightmoni:v0.1.7-20261118-132142-amd64`。
- `npm run version:check` 46/46 通过；`npm run build`、`npm run typecheck` 通过；Agent 升级、中心 SSH 派发和能力投影定向测试 101/101 通过。

## 镜像发布与隔离验证

- 版本 PR #257 已合入 `main`，合并提交为 `b3ae864c8fe2c6a7cc96e96af224516ff1529eb5`；从该提交构建 `linux/amd64` 镜像。
- 已推送固定版本标签和 `latest`；两者回读 digest 均为 `sha256:4089d1f3dce99717548a7ebfc95ac166c1ed479de4c8188f5a58f63967229698`，OCI revision 与合并提交一致。
- 隔离 Compose 验证：中心和 ClickHouse 均 healthy，`/healthz` 与首页返回 HTTP 200，受保护 API 在无认证时返回 HTTP 401；隔离卷已清理。

## 生产中心

- 切换前在 `/root/lightmoni-upgrades/20261118-142555-v016-to-v017` 留存 Compose、运行时配置、主密钥及 SQLite 一致性快照；快照 `PRAGMA integrity_check` 为 `ok`。该目录仅在生产主机上，不进入仓库。
- 仅替换 Compose 的 LightMoni 镜像标签；`docker compose config --quiet` 和 `docker compose up -d --no-build --wait lightmoni` 通过。LightMoni 0.1.7 与原 ClickHouse 26.8 均 healthy；原数据卷保留。
- 公网 `https://moni.heyphp.com/healthz` 返回 HTTP 200，状态为 `ok`。

## `zz-bj-1` Agent 状态

- 目标主机 `lightmoni-agent.service` 为 active，当前发行目录仍是 0.1.1；尚未声称升级完成。
- 平台升级入口被一条 2026-11-18 21:22:50（北京时间）的历史 `operations.managed.v1` 任务阻止。其平台操作为 `inspect`，执行结果为 `unknown`，对应提权作业及任务中心记录均未核对结束。远端未发现仍在运行的对应操作进程。
- 后续需通过平台的提权执行核对入口记录现场检查，再执行受管 Agent 升级；验证 Agent 版本、心跳、服务和 Registry 容器后补录结果。
