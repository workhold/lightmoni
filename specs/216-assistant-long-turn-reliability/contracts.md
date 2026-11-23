# Contracts

## 后端行为契约

- `registerAssistant` 新增模块选项 `maxTurnDuration?: number`（毫秒，默认 `1_800_000`，
  即 30 分钟；非正整数回退默认）。`turnTimeout` 语义变更为空闲超时：仅在无模型输出、
  无工具活动时计时，默认仍为 120000。
- turn 运行期间，SSE 在静默超过 15 秒时写出 `: ping\n\n` 注释帧；注释帧不进入事件存储，
  不携带 `data:`，现有客户端解析器忽略。
- 空闲超时与总上限中断的 `turn.failed` 文案分别为
  `assistant turn idle timeout` 与 `assistant turn reached its maximum duration`。
- 工具执行期间每 15 秒重申心跳并重置空闲 deadline；工具结果事件照常发出。
- 会话/事件存储形状、鉴权、审批与凭据检查均不变。

## 前端行为契约

- `TurnStreamError`：`streamTurn` 在 HTTP 失败（`http`）、流中断（`disconnected`）、
  帧格式错误（`protocol`）时抛出可识别错误；`disconnected` 保留原中文文案。
- `fetchSession(sessionId, signal)` 返回完整会话（含 events）。
- 流中断且非用户取消时，前端进入恢复轮询（2 秒间隔）：合并事件直至该 turn 出现
  `turn.completed/failed/cancelled`；连续 3 次轮询失败或轮询超过 30 分钟才回退为错误；
  恢复期间显示恢复提示，不写入错误 Alert。
- `ToolTrace.startedAt/endedAt`、`TurnView.startedAt/endedAt` 为可选 ISO 时间戳字段，
  仅前端视图层使用，不入库。
- 工具卡片默认展示摘要徽标；原始参数/结果 JSON 通过折叠面板访问。
