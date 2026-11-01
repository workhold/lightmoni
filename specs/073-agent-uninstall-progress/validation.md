# 验收记录

## 根因和最终行为

截图中的能力原因为 `uninstallation_pending`，不能据此宣称远端已卸载。既有列表仅给出详情历史提示；对话框的 apply 返回前不更新持久记录，且旧轮询要求 `!pending.current`，执行期间无法观测 running。另外 `applyAttempted` 同时禁用了取消按钮，导致请求失败但持久状态仍待审批时无法在原对话框取消。

修复后，列表可直接恢复该主机未结束的卸载记录；支持能力原因兜底，避免缺少当前 Agent 的最近卸载状态时丢失入口。审阅、取消、进展和只读核对使用既有 API。apply 派发即时说明等待结果，独立轮询真实记录；读取世代和组件销毁保护阻止旧响应回滚状态。取消仅允许尚待审批的原计划，服务端 busy 与 CAS 约束保持。状态、错误和操作在滚动正文外可见。

## 检查

- `npm --prefix web run typecheck`：通过。
- `npm --prefix web run build`：通过；保留既有第三方模块 `use client` 打包提示。
- `node --check web/src/app/verify-machine-agent-uninstall.mjs`、`git diff --check`：通过。
- [卸载回归](evidence/uninstall/uninstall-ui-report.json)：22 项通过，覆盖原计划恢复/取消、能力刷新、过期、未知结果、失败后取消、执行时轮询、迟到读取、防重、跨主机记录拒绝和中英文固定操作布局。
- [恢复卸载回归](evidence/recovery/recovery-ui-report.json)：17 项通过，包含身份与凭据边界、数据策略、失联恢复、脚本校验、中英文 1440/390 像素布局。
- [主机请求隔离回归](evidence/identity/ui-report.json)：13 项通过，包含迟到响应、主机切换、删除、离开忙碌页面与既有部署状态保护。

最终生产网页 bundle 的组合 SHA256：`c87c9e8ffbcefadb94cc7f58897d58698d58935d639bba6ce63e1273fb551768`（计算方法见恢复卸载验证脚本）。截图保存在被忽略的 `artifacts/screenshots/specs/073-agent-uninstall-progress/evidence/`，已查看中文审阅与英文 390 像素恢复卸载截图，状态及底部操作可见。

## 兼容性与边界

没有新增后端字段、端点、状态转移或存储迁移，旧计划继续使用原记录；过期和缺少快照的计划仍需取消并重新检查。unknown 仍必须显式只读核对，查看进展不会自动重放卸载。

所有浏览器请求均拦截在隔离 fixture 中，未连接用户主机、未执行真实 SSH/systemd、未更改生产卸载记录，未合并或发布镜像。当前线上可通过“详情 → 卸载历史 → 审阅卸载计划”继续或取消；unknown 使用只读核对。

架构同步：不适用。仓库章节与 Doca 链接/回读：不适用，理由见 spec.md；未改动任何架构或设计基线。
