# 验收记录（2026-10-17）

## 模型管理

- Runtime：TypeScript 检查及构建通过；35/35 项测试通过，涵盖四种实际 SDK 的文本、工具、历史整理、延续、取消、usage、缺失计数与错误隐藏。
- 后端：`go test -race ./internal/assistant ./internal/auth ./internal/server` 通过；新增计费、账本、价格快照、0/未知、去重、失败保留、205 个旧会话回填、时区/DST、多币种与管理员权限测试通过。
- 前端：助手及模型相关 36/36 项单测通过，TypeScript 与生产构建通过。
- 新管理页：8 组隔离浏览器验收通过，包括计费保存、null/0、过期身份冲突、范围/时区、模型/来源明细、多币种、缺失用量、空态/失败重试、迟到响应防覆盖、模型保存后重载、桌面及 390px 布局。
- 最终静态资源先构建，再嵌入 Go 服务，已在本地 8080 重启；健康检查正常，计费和统计接口未登录返回 401。正式构建上的管理页 8 组浏览器验收和助手未知用量展示检查通过。

修正了模型名称测试时去空格但保存时不去空格的不一致。OpenAI 兼容流式请求增加 `stream_options.include_usage=true`；测试供应商仅在收到该选项时返回 usage，修前失败、修后通过。所有已完成但缺失原始计数的请求记录为未知，不冒充免费。

## 助手与原模型配置复测

- 模型配置 20/20 浏览器场景通过，包括四种协议、手动/自动模式、常见地址修正、目录失败手工输入、权限、保存密钥绑定、超时、失败保存及测试按钮状态。
- 助手最终在 8080 正式构建上 14/14 浏览器场景通过，包括中文增量 SSE、工具执行和结果、历史重开续聊、停止、失败重试、管理员跳转/成员提示、草稿审阅、修改 SQL、保持原时间范围预览、用户显式保存，以及供应商未返回计数时显示未知且历史重开后保持。
- 浏览器使用独立 Chrome 和完整 API 拦截；运行时使用本地受控供应商。真实供应商请求、真实配置/大盘写入、真实 Key 读取均为 0。本验收不证明任何外部供应商当前在线、真实模型分析质量或实际账单金额。

原始证据位于 `.local-dev/assistant-acceptance-{runtime,config,ui}*`、`.local-dev/model-management-*`。浏览器场景与统计截图使用合成数据，不代表当前实例真实消费。

## 已发现的既有边界问题

1. Google 官方 OpenAI 兼容路径 `/v1beta/openai` 在自动模式会被域名提示识别为 Gemini 原生；当前需要手选 OpenAI Chat Completions。
2. 供应商不提供模型目录时，手填模型后的测试/保存不会自动为根地址补 `/v1`；当前须显式填写供应商实际 API 基地址。保留自定义路径，不扩展 `/v133` 等任意拼写纠错。

费用为按两种单价计算的估算，未实现缓存专门费率、阶梯价格或折扣。升级前未完成且未报告 usage 的请求及已被裁剪的历史不能恢复，旧记录模型及单价保持未知。

## 优化修复复验（2026-10-17）

- Runtime 71/71 项测试、TypeScript 和构建通过。四种实际 SDK 验证 HTTP 失败、断流、读取错误、worker/每次调用取消、两阶段及多工具请求的稳定 ID 与一次终态；本地上下文、序列化、测试预算拒绝不计请求。无计数保持未知。
- 连接测试检查最终序列化请求体，四协议输出预算最多 256 token；Anthropic enabled thinking 和无法容纳的 Gemini 固定思考预算在 HTTP 前返回 `test_budget_exceeded`，实际请求数为 0。自适应思考保留所选级别；有效 length/max_tokens 响应记录成功请求及已有用量，再返回 `output_limit`。不再静默扩张测试预算。
- `go test -race ./internal/assistant ./internal/auth ./internal/server -count=1` 全部通过，包含 worker 集成、并发终态合并、重放不改原价、部分计价、旧账本兼容、明细权限和限额。SQLite 关闭重开验证遗留 pending 一次转为 failed / service_interrupted，原终态及未知用量不变，二次启动幂等。取消后缓冲的记账帧仍被读取。
- 前端助手、模型及管理逻辑 36/36 项单测通过，TypeScript 和生产构建通过。管理页 11 组浏览器验收全部通过：同身份保存保留单价草稿、重载/更换确认、409 后暂停旧编辑、同步失败保留草稿、摘要与计费身份一致、刷新保分组/页码/旧结果、最近日期和今天标记、状态与部分费用、历史单价明细、桌面/390px、范围与迟到响应。
- 自动协议浏览器 5 组通过：唯一建议可直接测试且提交具体协议、歧义禁用、手选覆盖、迟到响应不能恢复旧地址/协议、恢复有效地址重新识别。可重跑 `node web/src/features/assistant/verify-model-auto.mjs`；管理页可重跑 `node web/src/app/verify-model-management.mjs`，均支持 `LIGHTMONI_TEST_BASE_URL`。
- 最终生产静态资源嵌入 Go 后在 8080 重启，健康检查正常；billing/usage/details 未登录均 401。正式构建上重新运行管理页 11 组、自动协议 5 组和 AI 助手 14 项交互检查，全部通过。助手覆盖中文流式回复、工具与结果、历史续聊、停止、失败重试、管理员入口、成员权限及草稿预览/显式保存。

本轮证据：`.local-dev/model-management-optimization-go-race.log`、`.local-dev/model-management-final-{web-tests,browser,auto,assistant}.log`，管理截图及 JSON 位于 `/tmp/lightmoni-model-management-*`。全部供应商及浏览器 API 使用隔离 fixture，真实供应商调用、真实模型配置写入、真实 Key 读取为 0。
