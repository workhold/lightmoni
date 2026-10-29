# 主干同步、分支推送与开发服务

2026-10-29，按用户要求推送代码并启动服务，沿用 `codex/033-operations-control-plane` 和 [PR #15](https://github.com/workhold/lightmoni/pull/15)。从 GitHub `origin/main` 同步 e7384bc，保留统一主机、登记接入和 SSH 凭据有效期功能。解决 App、导航定义和导航验收脚本三处冲突：`/machines`、`/agents` 使用主干统一主机工作区，普通成员保留只读权限；`/services` 使用本功能的托管服务跳转，运维侧栏保持单一入口。

运维平台候选节点和工作负载调度查询使用主干已有的节点生命周期，排除已移除节点。新增真实 HTTP/SQLite 验收，确认移除节点不出现在候选列表，不能保存为新部署目标；即使心跳仍新鲜，也不能接收服务副本。

| 检查 | 结果 |
| --- | --- |
| 根目录类型检查 | 通过（Runtime、AI runtime、Web） |
| 根目录构建 | 通过（SDK、Runtime、AI runtime、Web） |
| Runtime 全量 | 518 项：497 通过、21 按环境跳过、0 失败，194.42 秒；包含新增两项生命周期验收 |
| API / 工作负载定向 | 19 项通过、0 失败、0 跳过 |
| 生产 bundle 导航与首页 | 15 项通过；覆盖统一主机、旧服务路由跳转、中英文、390px 和权限降级，见 evidence/main-sync-navigation/ui-report.json |
| 差异检查 | 无遗留冲突标记，git diff --check 通过 |
| 开发服务 | 保留运行时凭据与原数据，使用最新构建重启 127.0.0.1:18880；/healthz 返回 status=ok，/operations 返回 200 |
| 前端开发入口 | 原 127.0.0.1:5173 继续运行，代理 /api/v1/setup 返回 200 |
| 当前登录浏览器 | 重载 18880/operations?tab=website，显示新版主机入口及完整运维概况，无状态读取错误，未新增业务资源 |

本轮架构同步不适用：合并并复用已有统一主机入口、节点生命周期和运维平台，没有新增组件职责、存储、协议、凭据或拓扑。仓库 system-design.md 自动合并保留两分支设计，Doca 既有同步证据保留；本轮没有重写或声称重新保存 Doca。

代码通过功能分支推送至 GitHub，PR #15 继续面向 main；尚未取得合并授权，不合并主干。
