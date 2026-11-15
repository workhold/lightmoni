# SDD 168 实施任务

- [x] T001 阅读主机列表、安装/卸载对话框、进度组件及现有 UI 验收，确定不改变 API 和状态机的展示范围。
- [x] T002 [US1] 修改 `web/src/app/MachinesPage.tsx`、`web/src/app/machines.css` 与 `web/src/app/operations.css`，增加部署和 Agent 管理的可见文字及局部布局。
- [x] T003 [US2] 修改 `web/src/app/AgentOperationProgress.tsx` 和 `web/src/app/MachineAgentUninstallDialog.tsx`，去重状态、重排成功回执、折叠原计划并提供完成按钮。
- [x] T004 [US3] 修改 `web/src/app/MachinesPage.tsx` 和 `web/src/app/MachineAgentUninstallDialog.tsx`，调整安装按钮和恢复卸载文案。
- [x] T005 [US1][US2][US3] 更新 `web/src/app/verify-agent-operation-progress.mjs`、`web/src/app/verify-host-execution-ui.mjs`、`web/src/app/verify-machine-agent-uninstall.mjs` 与 `web/src/app/verify-agent-maintenance-recovery.mjs`，覆盖新展示契约并同步现行菜单和凭据夹具。
- [x] T006 运行相关 UI 回归、类型检查、生产构建、桌面/窄屏截图和文档检查，填写 `specs/168-host-agent-lifecycle-ux/validation.md`。
- [ ] T007 同步 `origin/main`、审查最终 diff、提交并创建面向 `main` 的 PR，按用户授权以 merge commit 合入并回读验证。
