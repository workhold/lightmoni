# SDD 175 验证记录

## 生产只读定位（2026-11-16）

- 中心已通过 1Panel 原升级流程从 0.1.1 更新到 `v0.1.2-20261115-152221-amd64`，拉取、替换、健康检查和任务结束均成功；生产页面可正常读取。
- 云终端只读确认 vchive 的 `/opt/lightmoni-agent`、程序启动器、两个 systemd 单元和原更新事务目录均不存在，无 Agent 工作进程；`/etc/lightmoni-agent` 与 `/var/lib/lightmoni-agent` 的配置/身份/缓存仍保留。
- 使用中心容器只读 SQLite 查询（readOnly，仅非秘密字段）确认当前 Agent 仍有有效关联，历史 executor 均已 revoked，但同机存在六条不同 Agent ID 的 active enrollment。未读取凭据密文，未直接修改数据库。
- 原生状态修正计划因“另一 Agent 的有效身份”拒绝创建，未执行状态修正、升级、卸载或重装。

## 自动验证

- `machine-state-recovery.test.ts`：8/8 通过。新增同机当前/历史 enrollment 均进入计划并取消、其他主机不变，以及审批后新增 enrollment 使快照失效的回归。
- 原 active executor、跨主机任务/维护、有效程序、锁、身份错误、目标/凭据/远端漂移仍失败关闭。
- 状态修正成功只表示中心旧状态解除，不表示重新安装或 Agent 在线。

- 状态修正、安装恢复竞态与 Agent 生命周期交叉回归：60/60 通过。`npm run typecheck`、`npm run build`、版本一致性 46 项、文档链接/围栏和 `git diff --check` 通过。

## 交付边界

本次修复不直接修改生产数据库，不自动审批。发行、中心部署、生产状态修正及重新安装均需按原流程执行并另行记录。
