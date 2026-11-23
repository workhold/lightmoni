# SDD 216 实现计划

## 后端（runtime/src/assistant/index.ts）

1. 超时改造（turn 装配处，~1068）：
   - 新增模块选项 `maxTurnDuration?: number`（默认 `30 * 60_000`，非法值回退默认）。
   - 用可重置的空闲 deadline 替代 `AbortSignal.timeout(turnTimeout)`：
     `setTimeout` 触发 `controller.abort()`；`emit()` 真实事件与工具执行期间重置；
     总上限用独立的绝对 deadline 定时器，不可重置。
   - 中断文案：空闲 → `assistant turn idle timeout`；总上限 →
     `assistant turn reached its maximum duration`（区分 `timeout.aborted` 语义）。
2. 心跳与看门狗：
   - turn 运行期间静默 15 秒写 `: ping\n\n`（`res.write`，无需持久化）。
   - 工具 execute 回调内启动看门狗 interval：每 15 秒写 ping 并重置空闲 deadline；
     回调返回后清理；turn `finally` 清理全部定时器；定时器 `unref()`。
3. 测试（runtime/test）：新增/扩展用例覆盖静默长工具存活、空闲超时、总上限、心跳帧。

## 前端（web/src/features/assistant/）

1. `types.ts`：`ToolTrace` 增加 `startedAt?/endedAt?`；`TurnView` 增加 `startedAt?/endedAt?`。
2. `timeline.ts`：事件时间戳写入上述字段；终态事件写 `endedAt`。
3. `client.ts`：
   - 导出 `TurnStreamError`（`code: 'disconnected' | 'protocol' | 'http'`），流中断抛
     `disconnected`，文案保留"连接已中断，请读取会话历史确认结果"。
   - 导出 `fetchSession(sessionId, signal)`（GET `/assistant/sessions/:id`）。
4. `AssistantPage.tsx`：
   - `runTurn`：流错误为 `disconnected` 且非用户取消 → 恢复模式（2s 轮询合并事件；
     终态出现即结算；连续 3 次失败或客户端 30 分钟上限才报错；恢复期间
     `recovery` 状态位供 UI 显示"连接中断，正在恢复…"）。
   - 运行条 `lm-assistant-runbar`：会话运行中显示当前工具名、已用 mm:ss（每秒 tick）、
     步数、停止按钮（复用 `cancel()`）。
   - `ToolActivity`：摘要行加已用时间；运行中自动展开逐工具行（状态点/名称/各自耗时）。
   - `ToolProgress`：新增 `toolSummary(name, input, result, t)` 纯函数输出徽标数组；
     卡片默认展示徽标行，原始 JSON 折叠；现有 SQL/SSH 终端等特化展示保留。
5. `WorkbenchInspector.tsx`：activity 卡片显示 turn 耗时。
6. `assistant.css`：diff 确认后删除两处整段重复块；新增运行条、工具行、徽标、恢复提示
   样式（沿用 `--as-card-*` 变量）。

## 验证

1. `npm run typecheck`。
2. `npm --prefix runtime test`（assistant 相关）；`node --test web/src/features/assistant/*.test.mjs`。
3. Playwright fixture 验证脚本（仿 `verify-conversation-ui.mjs`）：mock SSE 静默→恢复，
   断言恢复提示、运行条、工具徽标；截图入 `specs/216/evidence/`。
