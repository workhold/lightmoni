# 验收记录

## 架构同步

适用：Agent 本地 pending payload 的生命周期、Docker 日志补采起点和 Agent→中心的发送节奏发生变化。仓库设计见 `docs/system-design.md` 第 18.2 节及第 134 章；在线设计见 [Doca：LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 第 134 章。

2026-11-13 写入 Doca 后以最新 seq 1808、epoch `63d4490e-11da-4b5a-8674-cd671d8ad4b6` 回读：文档标题为“LightMoni 系统设计基线”；新增第 134 章位于既有 `sdd131-assets` 后，134.1、134.2、134.3 正文及引用块顺序正确；新增原生流程图有 6 个节点、5 条连线，端点均存在。原总览图 `f-architecture-8a1f` 仍为 10 个节点、8 条连线，节点 ID、连线 ID 与端点和写入前一致；既有 `host050-design-6` 图仍为 7 个节点、7 条连线。没有替换原有图块或改写无关正文。

## 自动验证

- `runtime`: `npm run typecheck` 通过。
- `runtime`: `node --import tsx --test test/agent.test.ts test/application-observability.test.ts test/platform-registry-images.test.ts test/managed-executor-jobs.test.ts`，72/72 通过。覆盖重启清理、容量释放、receipt 保留、ACK 后节流、旧 Docker 日志跳过、提权围栏与仓库已有安全边界。
- `web`: `npm run typecheck` 通过；`node --import ../runtime/node_modules/tsx/dist/loader.mjs --test test/ops-model.test.ts`，1/1 通过。覆盖已核实运行、保留地址、宽限、过期观察、未知执行结果及初次部署。
- `web`: `npm run build` 通过（Vite 现有分包大小提示）。
- `git diff --check` 通过。

## 应用页加载补充验收

用户追加的加载缓慢问题经代码路径定位：`OperationsPage` 每 10 秒自动请求总览，旧实现每次递增请求序号并丢弃更早结果；当服务端响应超过 10 秒时，首屏结果可能持续失效。新实现使自动刷新与窗口聚焦跳过正在执行的读取，手动刷新及筛选变化仍取消旧请求。中心 `/ops/overview` 原本为列表和总数调用两次 `store.list()`，现复用一次读取。接口字段与上限不变。

`web/test/slow-applications-load.mjs` 使用真实页面和延迟 11.5 秒的只读模拟接口；首次请求完成后应用卡片可见，自动轮询未产生新请求。React 开发模式 StrictMode 发起两次紧邻的初始请求，前一次按预期取消。`runtime/test/platform-api.test.ts` 17 项通过、1 项既有跳过；两端类型检查通过。该补充只调整现有读取调度与重复计算，架构影响“不适用”：组件职责、数据/控制路径、存储、协议、凭据和部署拓扑不变。

## 兼容性与上线边界

旧 Agent 配置加载后自动取得 1 小时保留窗口和 1 秒成功发送间隔；显式 `max_age_seconds` 不改写。超过有效窗口的 pending payload 将被删除，receipt 仍按自身期限去重；隔离数据仍由人工处理。原始事件时间不平移，因此历史图表仍落在实际发生时间。生产主机中已存在的未知提权任务须由管理员根据现场证据核对后按既有流程结束；本 PR 不解除线上围栏，也不代表已在生产环境修正状态。
