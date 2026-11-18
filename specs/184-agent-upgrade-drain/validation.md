# SDD 184 验证记录

## 生产只读排障（2026-11-18）

- zz-bj-1 的 `lightmoni-agent` 为 0.1.1，systemd 服务运行；受管 Registry 容器保持运行。当前中心可用发行包为 0.1.6。
- 旧 Agent 不提供 `operations.platform.reconciliation.v1`，中心的 15 秒 tick 按实例健康间隔持续排入兼容性 inspect。四个应用实例的检查轮流占用同一主机 SSH 车道；主机忙状态显示 `terminal`，一键升级在预约之前被 `idle()` 拒绝。
- 一条结果未知的检查已对照远端作业与容器状态核对后人工结束，平台保留“结果未知，已人工核对”，未将其伪造成成功。其后新检查继续出现，证实问题是调度与维护入口的竞争，而非一次性残留锁。
- 本轮未改变生产配置、数据库或 Agent 发行；生产升级需经 PR 合入、中心发布后按既有受控入口执行。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| `runtime` 定向测试：`machine-maintenance`、`machine-agent-updates`、`managed-machines` | 182/182 通过。新增运行检查排空、SSH 车道占用、unknown 拒绝、超时释放、普通计划保持即刻空闲与回退入口门禁断言。 |
| `runtime` 与 `web` typecheck | 均通过。 |
| `runtime` 与 `web` build | 均通过；Web 构建含依赖包既有指令警告。 |
| `npm run version:check` | 46 项通过。 |
| `git diff --check` | 通过。 |

## 架构影响

中心调度与 Agent 升级的控制路径有变化，已在同一分支更新 `docs/system-design.md` §184。凭据权限、持久表结构、Agent 协议和业务容器行为不变。
