# SDD 179 验证记录

> 以下仅记录本仓库运维侧实际完成的步骤；镜像构建与隔离验收由 SDD 179 作者完成（本记录未复跑）。

## 生产替换与线上验证（2026-11-16，运维补充）

- 经管理员批准，生产中心由 `v0.1.4-20261115-165712-amd64` 切换至本发行 `v0.1.5-20261115-182326-amd64`。切换前远端回读固定标签摘要 `sha256:249df57c56dd4cc22871b6d202b9d77207955d7059eca75353e838748a81dfe0`（业务 manifest linux/amd64）。
- 切换前备份 `/root/lightmoni-upgrades/20261116-v014-249df5-to-v015-preswitch/`：compose.yaml、env、master.key、release.json、3.28GB `VACUUM INTO` 快照（integrity ok）。回滚目标为 v0.1.4 固定标签。
- 切换后容器 healthy；`/healthz` 200；实例设置回读 `version=0.1.5`；5 台主机在线；4 应用实例经既有串行核对流程陆续回到 in_sync（系统镜像仓库即时 in_sync）。
- 观察到 zz-bj-1 的 Agent（仍为 0.1.1）心跳间歇性中断，Agent 侧报 `control: no verified center endpoint is reachable`，恢复循环按设计进入 pending/agent_offline 并在连通后自动收敛；属主机到中心的网络可达性问题，非本发行缺陷，未做代码变更。
