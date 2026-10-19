# 验证记录

## 自动化检查

- `npm --prefix runtime run typecheck`：通过。
- `npm --prefix runtime test -- --test-name-pattern='alert|assistant|code task'`：177 项，174 通过、3 跳过、0 失败。覆盖规则/静默共享能力、提案持久化与重启、权限/版本/TTL、并发冲突、事务回滚、助手工具边界及 Mastra worker 工具循环。
- `npm --prefix ai-runtime run typecheck`：通过。
- `npm --prefix ai-runtime test`：71 项，71 通过、0 失败。
- `npm --prefix web run build`：通过。仅有依赖侧 `use client` 指令和已有大 chunk 警告。
- Web 现有应用测试：`node --test src/app/model-management.test.mjs src/app/sdkExamples.test.mjs`，12 项通过。
- `git diff --check`：通过。

## 浏览器验收

- `node scripts/verify-alert-controls-ui.mjs`：通过。覆盖提案回读、不可确认状态、完整 SQL/影响信息、审阅弹窗、重复点击防重、409 冲突、移动端溢出、成员权限、告警上下文和变更后回读；无页面错误。
- `LIGHTMONI_TEST_SCENARIO=receipt node scripts/verify-alert-controls-ui.mjs`：通过。覆盖静默结束的实际回执展示、预览时间保留、已完成提案不可重复确认及工具标签。

浏览器脚本使用受控 fixture 验证交互和状态机，不代表真实供应商模型质量。真实短信/电话/邮件供应商、ClickHouse、Linux Agent 发布、Kubernetes 部署和真实模型质量验收不在本规格范围内。

## 已知边界

规则读写沿用既有告警页面权限模型；本次没有新增角色矩阵。静默读取同样沿用现有登录用户边界。模型只能读取数据并生成待确认提案，实际应用仍由已登录用户在同源 UI 中确认，且服务端会再次校验权限、版本和提案有效期。
