# SDD 183 验证记录

日期：2026-11-16。仅记录本执行路径实际完成的步骤。

## 版本准备与镜像发布

- 版本 PR [#254](https://github.com/workhold/lightmoni/pull/254) 已合入：统一平台、Agent、SDK、MCP 与构建版本为 0.1.6，`npm run version:check` 46/46 通过；Compose 固定标签 `docker.heyphp.com/lightmoni/lightmoni:v0.1.6-20261116-060123-amd64`。
- 发布内容：SDD 180（PR #251，Runtime 测试语义与待审批零进度）、SDD 181（PR #252，集群导航与主机归属）、SDD 182（PR #253，统一镜像与仓库页面）。构建源码为 `main@5ac754ada681f4eb55d4bcdc1559d38b5e6294c2`。
- 在隔离 `colima-qa` 上下文从该提交本地构建 linux/amd64 中心镜像，未使用 GitHub 流水线。镜像 OCI revision 与源码提交一致。
- 镜像内 `SHA256SUMS`、`SDK_SHA256SUMS` 均通过；双架构 Agent release 的 version、arch 和 source_revision 均匹配 0.1.6 与上述提交。
- 隔离验收使用独立网络、临时容器和随机 0600 env，验收后已清理：`/healthz` 与首页 200；未认证实例设置与 MCP 为 401；初始化后实例 `version=0.1.6`；短期 MCP PAT 的 `initialize` 返回 `serverInfo.version=0.1.6`。
- 已推送固定标签与 `latest`，远端回读两者摘要均为 `sha256:bef2ffb42ec599c31ed1ce6817431b43b037499f666efdd0c1f37352beeaeeaa`。业务 manifest 为 linux/amd64，另一 unknown/unknown 条目为 BuildKit attestation；显式 linux/amd64 回读后 OCI revision 与构建提交一致。

## 轻量一致性备份

- 升级前实际运行镜像为 `v0.1.5-20261115-182326-amd64`，以此作为回滚目标。生产 Compose 目录为 `/opt/lightmoni/lightmoni`。
- 备份目录 `/root/lightmoni-upgrades/20261116-060735-v015-to-v016`：Compose、`.env`、主密钥、release.json 与 `lightmoni.sqlite`。
- 通过运行中中心容器的 `VACUUM INTO` 生成 SQLite 一致性快照，`PRAGMA integrity_check` 返回 ok；快照复制大小 3.32 GB。主密钥仅检查存在并复制，未打印或读取其内容。
- 未对 31.87 GB 遥测卷执行停服务全量压缩，未删除或恢复任何数据卷。

## 1Panel 生产切换与线上验证

- 用户确认后，仅将 Compose 固定标签改为 `v0.1.6-20261116-060123-amd64` 并保存。1Panel 拉取成功，ClickHouse 保持运行且健康，中心容器完成 Recreate/Started；更新任务于 2026-11-16 14:23:38 +08:00 成功结束。
- 1Panel 容器列表回读：中心运行镜像确为上述 0.1.6 固定标签且 `Up About a minute (healthy)`；ClickHouse 为 `Up 11 hours (healthy)`。旧 `lightmoni_lightmoni-state` 卷仅提示名称不匹配并保持不动，实际外部 `lightmoni_lightmoni-state-v2-20261103` 未被替换。
- `https://moni.heyphp.com/healthz` 返回 200 `{"status":"ok"}`，首页 200。主机页显示 5 台主机全部在线，所属集群/未分配集群列与筛选均已生效。
- 左侧已显示“镜像与仓库”和“集群管理”。统一页面的镜像与版本、仓库与发布入口、凭据与来源代理三个标签均回读成功：系统仓库部署、`docker.doc-a.cn` 对外入口、绘本凭据及 docker.io → mirror.ccs.tencentyun.com 代理均保留。

## 边界与未决恢复

- 中心重启后，小猪绘本、OpenResty、PostgreSQL、系统镜像仓库仍显示“待核实/结果未知”，不能记为业务恢复完成。最近一次绘本原生 inspect 为成功（2026-11-16 12:54:05），但旧 unknown 记录仍构成恢复围栏。
- 未自动清理未知任务、重放部署或读取敏感输出。本发行记录只确认中心升级与新界面生效，应用恢复仍需按既有只读核对流程收敛。
- 主机 Agent 不会被中心镜像自动升级；另有主机更新任务正在按独立流程进行，未将其计为本发行验收。
