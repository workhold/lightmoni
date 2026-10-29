# 验收记录

## 实现结果

管理员列表首列支持复选框、全选、跨分页保留和清除选择，每批最多 50 项。标签过滤或刷新使记录消失时剔除选择；打开窗口后固定目标快照。批量 SSH 安装检查、宿主机 Agent 部署、Agent 卸载、节点移除和主机记录删除复用现有单项 API，逐项说明资格、凭据、计划和结果。

安装/卸载先逐台预检并持久化计划，审阅目标身份、步骤、影响和期限后统一确认。每台安装架构来自自身预检。串行执行、同步防重、失败继续；停止仅影响后续目标。未执行计划可逐项取消，取消失败保留窗口。通信中断回读原计划，创建响应丢失按本次 check/credential 恢复唯一计划，不重复写入；未知结果保留核对及历史入口。单独主机历史链接可直接打开详情，并显示失效记录错误。

## 自动验证

- `npm --prefix web run build`：通过，包含 TypeScript 项目检查与生产构建。
- `node web/src/app/verify-bulk-host-node-actions.mjs`：24 场景通过，0 页面错误、0 意外网络请求。报告：[bulk-host-node-ui-report.json](bulk-host-node-ui-report.json)。
- 复用 `verify-hosts-nodes.mjs`、`verify-machine-list-delete.mjs`、`verify-machine-ssh.mjs`、`verify-machine-agent-uninstall.mjs`：分别 13、14、18、14 场景通过，共 59 场景，0 页面错误、0 意外网络请求。报告在 [regression](regression/)。
- 合计 83 个隔离生产 bundle 场景；覆盖权限、跨页选择/50 上限/过滤剔除、混合目标、多凭据选择、一次性密码、HTTP 200 但预检未就绪、amd64/arm64、两阶段确认、计划过期、创建响应丢失、取消失败、部分失败、停止后续、防重、未知卸载读取原计划、节点移除与主机删除区分、中英文及 390px。
- 独立只读审查已完成，修复离页停止调度、角色变化清理、删除缓存清理、未知状态分类和无计划历史深链。`git diff --check` 通过。

后端未变，本轮不重复执行 Runtime 全量测试；基线测试见 `specs/034-unified-host-nodes/validation.md`。

## 本地展示与边界

真实本地平台保留在 `http://127.0.0.1:18080/machines`，使用隔离 SQLite/ClickHouse。通过实际页面勾选演示记录，核对操作栏、固定目标、宿主机说明和缺少 SSH 条件的不可执行原因；未生成远端计划或发起 SSH。演示记录可能包含此前验收归档的节点，界面依据当前实际状态展示。

实际页面截图已查看：

- `artifacts/screenshots/specs/035-bulk-host-node-actions/local-bulk-list.png`
- `artifacts/screenshots/specs/035-bulk-host-node-actions/local-batch-preview.png`

测试中的 SSH、安装、卸载和写入响应均由隔离 API 夹具提供。本轮没有操作线上平台或 vchive，也未发布镜像。页面关闭不承诺继续调度，以各主机持久化历史为准。

## 架构与交付

本轮架构同步不适用：仅浏览器内选择、确认与串行编排，未新增后端批量任务、存储、认证、协议、控制路径或部署拓扑，服务器仍逐请求校验原有守卫。没有无意义地改写仓库/Doca 架构基线；PR14 原有统一主机与节点架构的 Doca 同步证据继续见 `specs/034-unified-host-nodes/doca-sync.json`。

交付更新现有 GitHub PR14，目标 `main`，不自动合并。提交前 fetch 的 `origin/main` 为 `dd1279beac4f7890ae9998b192127112e6d65e08`，已包含在功能分支历史中。
