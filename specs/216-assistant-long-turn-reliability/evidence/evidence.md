# SDD 216 验收证据（2026-11-23）

## 自动化测试

- `runtime/test/assistant.test.ts`：25 通过，含 4 个新用例——
  1. `a silent long tool survives the idle deadline and keeps the stream pinged`
     （静默 4 秒工具在 1.5 秒空闲 deadline 下存活，SSE 出现 ≥2 个 `: ping` 帧）；
  2. `an idle turn is aborted with the idle copy`（`assistant turn idle timeout`）；
  3. `steady progress past the duration cap is aborted with the cap copy`
     （持续输出越过总上限 → `assistant turn reached its maximum duration`，
     事件类型为 `turn.failed` 而非 `turn.cancelled`）；
  4. `assistant timing options are validated at registration`。
- `runtime/test/assistant-{agent-updates,alerts,tasks,host-installation,instrumentation-tools}.test.ts`：31 通过。
- web 单测（`assistant.test.mjs`、`tool-summary.test.mjs` 等，`node --test`）：38 通过，
  含时间戳记录与 `TurnStreamError(code='disconnected')` 新断言。
- `npm run typecheck`（runtime / ai-runtime / web）全部通过。

## Playwright UI 验证

`web/src/features/assistant/verify-long-turn-ui.mjs` 通过，结果见 `browser.json`：

- 长静默工具：运行条（`runbar-long-tool.png`）显示当前工具、已用时间与步数，
  活动摘要展开逐工具行；完成后运行条消失。
- 断线恢复：SSE 无终态中断后显示"连接中断，正在恢复…"（`recovery-polling.png`），
  轮询拿到终态后正常渲染答复，无错误 Alert。
- 工具徽标（`tool-badges.png`）：`run_query` 默认显示 `2 行 / 12 ms / 结果已截断`，
  原始 JSON 折叠在"原始参数与结果"内可展开。

## 预存失败（与本次无关，已在基线验证）

- `runtime/test/sdk-release-scope.test.ts` 与 `test/http-lifecycle.test.ts` 等
  Agent release/lifecycle 用例在干净基线上同样失败（缺本机构建产物）。
- `web/src/features/assistant/agent-update-progress*.test.mjs` 在基线上同样无法
  解析无扩展名导入（运行方式问题）。
