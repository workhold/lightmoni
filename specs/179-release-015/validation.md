# SDD 179 验证记录

> 以下仅记录本仓库运维侧实际完成的步骤；镜像构建与隔离验收由 SDD 179 作者完成（本记录未复跑）。

## 生产替换与线上验证（2026-11-16，运维补充）

- 经管理员批准，生产中心由 `v0.1.4-20261115-165712-amd64` 切换至本发行 `v0.1.5-20261115-182326-amd64`。切换前远端回读固定标签摘要 `sha256:249df57c56dd4cc22871b6d202b9d77207955d7059eca75353e838748a81dfe0`（业务 manifest linux/amd64）。
- 切换前备份 `/root/lightmoni-upgrades/20261116-v014-249df5-to-v015-preswitch/`：compose.yaml、env、master.key、release.json、3.28GB `VACUUM INTO` 快照（integrity ok）。回滚目标为 v0.1.4 固定标签。
- 切换后容器 healthy；`/healthz` 200；实例设置回读 `version=0.1.5`；5 台主机在线；4 应用实例经既有串行核对流程陆续回到 in_sync（系统镜像仓库即时 in_sync）。
- 观察到 zz-bj-1 的 Agent（仍为 0.1.1）心跳间歇性中断，Agent 侧报 `control: no verified center endpoint is reachable`，恢复循环按设计进入 pending/agent_offline 并在连通后自动收敛；属主机到中心的网络可达性问题，非本发行缺陷，未做代码变更。

## 本地构建与 1Panel 复核补充（本执行路径）

- 版本 PR [#246](https://github.com/workhold/lightmoni/pull/246) 的 `npm run version:check` 46/46 通过。构建源码为 `main@f3a8deed43b53fc5df50c1caf1643d2d656fa377`；第一次在本机 `colima-moni-acceptance` 的 amd64 `npm ci` 阶段出现 Segmentation fault，未产生或推送镜像，随后改用既有隔离 `colima-qa` 上下文从同一提交构建成功，没有使用 GitHub 流水线。
- 镜像 linux/amd64 与 OCI revision 核验通过。镜像内 `SHA256SUMS`、`SDK_SHA256SUMS` 均通过；双架构 Agent release 的 version、arch 和 source_revision 均匹配 0.1.5 与上述提交。
- 隔离验收使用独立网络、临时容器和随机 0600 env，验收后已清理：`/healthz` 与首页 200；未认证实例设置与 MCP 为 401；初始化后实例 `version=0.1.5`；短期 MCP PAT 的 `initialize` 返回 `serverInfo.version=0.1.5`。
- 固定标签与 `latest` 已推送，远端回读两者摘要均为 `sha256:249df57c56dd4cc22871b6d202b9d77207955d7059eca75353e838748a81dfe0`。业务 manifest 为 linux/amd64，另一 unknown/unknown 条目为 BuildKit attestation；显式 linux/amd64 回读后 OCI revision 与构建提交一致。
- 除上述运维备份外，本执行路径通过 1Panel 额外创建停服务一致性备份 `lightmoni_202611160232093m7af.tar.gz`，最终状态成功、大小 31.87 GB，包含编排、环境文件及两个容器的数据卷。两个容器分别备份成功后，总归档仍在处理临时目录；为减少停机，先通过 1Panel 启动原 0.1.4 编排并确认健康/首页 200，最终备份记录仍为成功。
- 用户确认后，仅将 Compose 固定标签改为 `v0.1.5-20261115-182326-amd64` 并保存。1Panel 拉取成功，ClickHouse 保持运行且健康，中心容器完成 Recreate/Started；更新任务于 2026-11-16 10:05:11 +08:00 成功结束。
- 1Panel 容器列表回读：中心运行镜像确为上述 0.1.5 固定标签且 healthy，ClickHouse 也 healthy。Compose 对旧 `lightmoni_lightmoni-state` 卷仅提示名称不匹配并保持不动，实际使用的外部 `lightmoni_lightmoni-state-v2-20261103` 未被替换。
- `https://moni.heyphp.com/healthz` 返回 200 `{"status":"ok"}`，首页 200，主机页显示 5 台主机全部在线；vchive 继续保持仅监控，主机 Agent 未被中心镜像自动升级。
- 本执行路径曾观察到 OpenResty 与 PostgreSQL 的自动核对在 10:07、10:08 返回 `ssh_dispatch_failed`，未人工重放部署或读取敏感输出；随后两项均恢复“运行中”，与上方运维补充的串行收敛记录一致。
