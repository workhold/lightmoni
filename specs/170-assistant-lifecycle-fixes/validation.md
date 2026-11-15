# SDD 170 验证记录

## 根因与现状核对

- 历史摘要达到输出上限时，旧实现直接抛出 `summary_failed`；生产截图中的摘要输出为 1,024 tokens，与旧摘要上限一致。四协议 fixture 现已覆盖 `length/max_output_tokens` 的降级路径。
- 助手卡片旧实现只在创建或审批时写入记录，没有读取后续终态，因此原生记录已经 `succeeded` 时仍可能显示“正在更新”。
- `vchive` 的只读 SSH 预检证明 Agent 安装和 root 连接存在；离线心跳不等于未安装。该主机仍有 unknown 更新记录及恢复响应未确认围栏，本次未执行生产核对、恢复、升级或卸载，也未清除围栏。

## 自动验证

- `npm --prefix ai-runtime test`：84 项通过。四种协议均验证截断摘要继续主回答、保留当前用户消息、持久化降级说明；摘要阶段供应商 401 仍为 `summary_failed`，不生成降级 checkpoint。
- `node --import tsx --test test/assistant.test.ts`（`runtime/`）：19 项通过，覆盖 degraded 事件与摘要 checkpoint 持久化。
- `node --import tsx --test test/machine-agent-updates.test.ts`（`runtime/`）：86 项通过，原审批、恢复、unknown 和维护围栏语义未改变。
- Web 助手 SSR/单元测试：36 项通过，覆盖 degraded 时间线、原生更新记录校验和渲染。
- `node web/src/features/assistant/agent-update-progress-polling.mjs`：5 项真实浏览器隔离验收通过，覆盖 running→succeeded、failed、unknown、读取失败恢复、卸载停止轮询；所有 API 均为本地 fixture。
- `node scripts/test-agent-update-direct-ui.mjs`：13 项生产前端 bundle 隔离验收通过，覆盖原更新记录、单机更新、移动端和主机操作菜单；不接触真实主机。
- `npm --prefix sdk/typescript test`：28 项通过。
- `npm run typecheck`、`npm run build`：通过；Web 仅保留依赖包既有的 `use client` 构建提示。
- `npm run version:check`：46 项通过，版本保持 0.1.1；本任务不发布镜像。
- `node --check`、Markdown 本地链接/代码围栏检查和 `git diff --check`：通过。

## 全量套件限制

仓库全量 `npm test` 未全绿，不能记为本次通过项。已核对该测试文件与当前 `origin/main` 一致，并独立复现 `install-release.test.ts` 的既有版本夹具问题：fixture 固定 `lightmoni-agent_0.1.0_linux_amd64.tar.gz`，而当前发行与安装器读取 0.1.1，导致测试在业务断言前报包不存在。全量运行还出现非本改动领域的 SSH/环境及发行资产失败。本 PR 未修改这些领域，以上述相关回归作为本改动验收依据，不伪称全量套件通过。

## 边界

改动只增加摘要不合格时的可继续降级、助手原记录只读轮询和主机列表现有快速刷新条件。未增加模型/MCP 写权限、通用 apply/approve/execute、自动恢复或自动卸载；未操作生产数据，未发布镜像。PR 编号与 merge commit 以 GitHub 最终记录为准。
