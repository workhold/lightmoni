# 实现设计

沿用 TypeScript/Node.js、SQLite、React/Ant Design 和 AgentJobStore。无新增依赖。

1. 将快速 Docker inventory 从应用指标/日志读取分离，统一使用固定 default context、有界输出和命令超时。失败分类为 CLI 缺失、权限不足、daemon 不可用、超时及通用失败；不返回原始 stderr。
2. Agent 心跳声明 `docker.inventory` / `docker.control` 能力；独立任务动作 `docker` 由 AgentJobRunner 分发到受限执行器。沿用任务持久化、崩溃未知状态和 lease renewal；写操作复用主机 operation-lock。
3. 管理员主机 API 创建/查询任务。主机与 Agent 绑定由服务器确定，容器必须来自新鲜清单。每主机一个活动 Docker 任务，浏览器 request_id 幂等；写动作要求 confirmed=true。任务审计携带 actor、machine_id、动作与容器 ID，不暴露租约。
4. inventory 读取在认证心跳和已验证任务结果之间按观测时间选择；仅接受与已存任务动作绑定的清单及操作结果。新心跳不能覆盖更新的即时结果；失败保留旧容器并展示原因。
5. UI 延续现有表格和主题，立即采集独立于 10 秒缓存轮询；轮询任务直到终态。启动/停止/重启确认后提交；切换主机/关闭窗口隔离异步结果。

宪章检查：管理员认证、Agent 凭据边界、确认和未知状态保守处理、先规格后实现、Doca 同步均适用。测试验证真实 SQLite/HTTP/任务租约与受限 Docker 命令，另记录本机真实 Docker 和 UI 验收边界。
