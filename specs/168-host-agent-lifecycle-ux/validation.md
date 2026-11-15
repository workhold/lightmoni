# SDD 168 验证记录

## 实现

- 未安装主机显示“部署 Agent”，已安装主机显示“Agent 管理 / Manage Agent”；原有菜单、能力判断、禁用原因和其他紧凑图标不变。
- 普通安装确认改为蓝色主按钮，卸载等破坏性动作仍使用危险样式。
- 卸载进度保留真实阶段和进度条，主状态只显示一次；成功页以目标、方式、数据策略和真实回执为主，原计划默认折叠且可展开。
- 成功页“完成”只关闭对话框，刷新仍为只读；恢复卸载显示名称去掉“强制”，`mode=recovery`、原因、purge 和核验契约不变。
- 验收夹具同步到现行 Agent 管理菜单、默认账户/凭据结构和异步只读核对流程。

## 自动验证

- `npm --prefix web run typecheck`：通过。
- `npm --prefix web run build`：通过，生成生产前端包。
- `node web/src/app/verify-host-execution-ui.mjs`：**27/27 通过**，覆盖可见部署/Agent 管理文字、安装非危险按钮、完整维护菜单及 390px 表格内滚动。
- `LIGHTMONI_QA_OUTPUT=.local-dev/evidence/168-host-agent-lifecycle-ux/uninstall node web/src/app/verify-machine-agent-uninstall.mjs`：**24/24 通过**，覆盖单一状态、回执优先、折叠计划、完成关闭、审批、取消、未知核对和防重复提交。
- `LIGHTMONI_QA_OUTPUT=.local-dev/evidence/168-host-agent-lifecycle-ux/recovery node web/src/app/verify-agent-maintenance-recovery.mjs`：**17/17 通过**，覆盖恢复原因、身份残留、purge、凭据范围、中英文和 390px 布局。
- `node web/src/app/verify-agent-operation-progress.mjs`：**11/11 通过**，保留原进度、轮询、异常状态和终态语义。
- `git diff --check`、SDD 本地链接及代码围栏检查：通过。

## 截图与边界

已回读桌面和 390px 截图：主机操作列、蓝色安装按钮、卸载成功页及恢复卸载计划。窄屏表格在自身容器内横向滚动，页面无横向溢出；滚动到操作列后 Agent 管理文字和菜单可用。

所有浏览器验证使用生产前端包或隔离 Vite bundle 与拦截/夹具 API，没有连接生产主机，没有执行真实安装、卸载、审批、SSH 或 Docker 变更。未修改后端 API、状态机、权限、数据或部署架构；架构影响不适用，未修改 `docs/system-design.md`。
