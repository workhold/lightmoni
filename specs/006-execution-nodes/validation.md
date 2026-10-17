# Validation — 2026-10-17

## Scope and specification

按 Spec Kit 的规格、设计、任务、实现、验收流程完成。规格质量检查 5/5；前置检查返回完整 research/data-model/contracts/quickstart/tasks。无扩展 hooks。变更与此前模型管理工作一同通过功能分支提交 PR #6，目标为现有主干 main，尚未合并。

## Backend

- `.local-dev/go/bin/go test -race ./internal/server -count=1` 全部通过（17.585s）。覆盖多标签 ANY 匹配及去重、任务撤除、空节点标签、标签与任务权限、默认及在用标签删除、稳定版本、同类配置冲突、数量限制、并发冲突及原子回滚。
- `agent_task_migration_test.go` 验证旧参数和目标表保留、用户默认名保留、重启不复活删除任务；旧接口不会克隆独立任务或删改已转移的迁移任务。
- `agent_task_runtime_test.go` 启动真实既有 Go Agent 循环：目录日志工作，增加第二标签后开始 HTTP 拨测，撤除全部标签后采集和拨测停止，业务 OTLP 转发继续。
- 首次注册任务冲突返回 409，且不留下半注册节点；重新注册及心跳保留中心标签。
- `.local-dev/go/bin/go test -race ./internal/agent ./internal/dashboards ./internal/assistant` 通过，包含原采集实现、自监控模板和已有 AI 管理回归。

## Frontend and artifacts

- `npm --prefix web run typecheck` 通过。
- 安装命令、SDK 示例、AI 助手、模型发现、地址、协议和模型管理 helper 共 44 项测试通过。
- `npm --prefix web run build` 通过；依赖 use-client 指令和大 chunk 提示属于构建警告。
- `.local-dev/go/bin/go build -o .local-dev/bin/lightmoni ./cmd/lightmoni` 通过，最终网页已嵌入服务。
- 安装/卸载脚本 `sh -n` 与 `git diff --check` 通过。

## Local service

使用 SQLite backup API 为原库建立权限 0600 的快照：`.local-dev/backups/before-execution-nodes-20261017-191628.db`。已重启当前本地服务，保持 `http://127.0.0.1:8080`，原数据与凭据不变。

`/healthz` 与 `/agents` 返回 200；未登录访问新标签、任务及节点管理 API 均返回 401。只读检查确认迁移版本一条、默认标签一条及三类迁移任务，`PRAGMA foreign_key_check` 无错误。本地当前无真实已注册节点，实际节点链路由隔离 Go runtime fixture 验证。

## Browser

执行 `LIGHTMONI_TEST_BASE_URL=http://127.0.0.1:8080 node web/src/app/verify-execution-nodes.mjs`，最终嵌入页面的 10 组验收全部通过。123 次 API 全部拦截，17 次模拟写入，真实 API/Key 写入和供应商请求均为 0，无 JavaScript 错误和未知端点。完整 [JSON 记录](../../docs/evidence/execution-nodes/browser.json)。

覆盖导航和三页签术语、节点状态与诊断、多标签与空标签、任务和标签 CRUD、启停及冲突失败保留输入、停用空任务重命名、启用空配置拒绝、旧安装深链、按启用任务计算授权表、无效标签、读取失败与重试、成员完整只读和空态。桌面 1440px 与窄屏 390px 页面及弹框无页面横向溢出，宽表在表内滚动。已查看六张截图，包括新任务长表单和节点标签弹框。截图保存在 `artifacts/screenshots/docs/evidence/execution-nodes/`（按仓库约定忽略本地截图）。

独立只读审阅覆盖前端状态、权限与深链，后端权限、迁移和合成事务；发现并修复旧接口克隆/删改独立任务，以及停用空任务表单无法修改的问题。没有遗留阻塞项。

## Deployment clarification

Agent 作为独立进程或容器运行，业务启停不触发 Agent 启停。修正规格、README 和接入示例中此前误写的共同启停描述，并同步 PR #6。检查既有 systemd 服务及前台 CLI 的独立运行与信号退出行为，页面没有绑定业务生命周期的描述。本次仅修正文档，`git diff --check` 通过，无运行代码变化。
