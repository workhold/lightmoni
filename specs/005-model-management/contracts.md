# API contracts

全部接口需要管理员。金额是估算值，单价以每百万 token 为单位。

## GET /api/v1/assistant/billing

返回 `{base_url, protocol, model, currency, input_price_per_million, output_price_per_million}`。两个单价为可空非负数，缺省 currency 为 CNY。身份来自当前连接；未配置模型时模型为空。

## PUT /api/v1/assistant/billing

请求/响应同上。币种 CNY 或 USD。必须提交当前连接身份，连接已更换返回 409；非有限/负数/超过 1e9 的价格拒绝。null 清除价格，0 表示免费。

## GET /api/v1/assistant/usage?days=30&timezone=Asia/Shanghai

days 仅 7/30/90，默认 30；timezone 默认 UTC，必须是有效 IANA 时区。返回 `{days, from, to, timezone, totals, daily, models, sources}`；from inclusive / to exclusive，为涵盖今天的完整日历日范围。

Stats: `{requests,input_tokens,output_tokens,total_tokens,input_missing,output_missing,total_missing,unpriced_requests,estimated_costs:[{currency,amount,requests}]}`。token 数是已知部分的合计，missing 是缺该数值的调用次数。daily 项含 `date`，models 项含 `base_url,protocol,model`，sources 项含 `source`（assistant/connection-test）。所有数组为空时使用 []。

账本按事件去重，连接测试也记录消耗但不创建会话、不保存连接、不返回模型正文。历史整理 phase=compact；正常 phase=execute。

## 请求生命周期与计价补充

运行时每次通过本地输入、SDK 序列化及预算检查，在实际 fetch 边界发出 `model.request.started {request_id,phase}`，完成后发出 `turn.usage {request_id,phase,status,...实际报告的tokens}`。状态为 pending/succeeded/failed/cancelled，旧记录未知。相同 session/turn/request_id 仅允许 pending→终态一次；Go 在 worker 中断后将仍 pending 的请求标记 failed/cancelled。服务启动先回填历史终态，再将剩余 pending 一次终结 failed，记录 `failure_reason=service_interrupted`、恢复时的 completed_at，保留开始时间及原费率。未知计数不推算为零。

Stats 增加 `succeeded_requests/failed_requests/cancelled_requests/pending_requests/unknown_status_requests/partial_priced_requests`。`unpriced_requests` 只计完全无法计价的调用，与部分计价互斥。estimated_costs 每项新增 `partial_requests`，amount 是该币种所有已知部分之和，requests 仅完整计价的请求数。

UsageRecord 保存 `request_id/status/input_price_per_million/output_price_per_million/input_estimated_cost/output_estimated_cost/cost_status`。cost_status 为 complete/partial/unpriced/legacy，旧金额保持且不补造单价；修改单价不影响已有终态。

`GET /api/v1/assistant/usage/details?days=30&timezone=Asia/Shanghai&limit=100` 仅管理员可读，以最近优先返回最多100条含单价及分项费用的账本，参数校验同统计，不包含提示词或密钥。

连接测试使用内部 RuntimeInput.connection_test 标记，公开配置不接受此选项；仍按选定思考深度请求，但实际协议总输出预算不得突破256。无法在该预算内配置思考时返回 `test_budget_exceeded`，已到达服务但输出预算不足返回 `output_limit`，与通用连接失败区分。自动模式唯一确定协议后可直接测试，歧义仍要求选择。
