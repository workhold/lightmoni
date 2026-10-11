# 07 — AI 助手

责任目录：`internal/assistant`、`web/src/features/assistant`。遵循 [公共契约](../contracts.md) 与 [UI 说明](../ui-design.md)。不修改 Doca 源仓库、全局依赖或应用路由，不读取本机其他项目的模型凭证。

## Doca 骨架审计与迁移

2026-10-10 只读检查 `/Users/zhangsiwen/dev/dsh/doca`，其根 `LICENSE` 为 MIT，版权 `2026 smartdoca`。`AGENTS.md` 允许只读调查；本次未修改 Doca，也未实施 Doca 的旧格式转换。对应声明保留在 `web/src/features/assistant/NOTICE.md`。

| Doca 原位置 | 骨架能力 | LightMoni 实现 |
| --- | --- | --- |
| `packages/ai-host/src/host.ts`、`registry.ts` | 域工具注册与宿主组合 | Go `Options.Tools`，主干注入 Catalog/Query，校验 read/draft effect |
| `packages/ai-host/src/events.ts` | 会话、步骤、工具、完成/失败/取消事件 | Go `Event`，持久 sequence + turn ID，React 事件时间线 |
| `packages/ai-host/src/tools.ts` | 参数、工具结果、取消与错误边界 | JSON Schema 工具定义、有界调用与统一 tool.call/tool.result |
| `apps/server/src/services/ai/model.ts`、`runner.ts` | provider 流式输出与工具循环 | Go 兼容 `/chat/completions` 的 SSE parser 与最多 8 步循环 |
| `apps/server/src/routes/ai.ts:1124` | 会话认证、SSE、持久历史 | 同源 authenticated turns SSE，SQLite 历史重读 |
| `apps/web/src/features/ai/ai-chat.tsx`、`ai-timeline.ts`、`ai-session-ux.ts` | 对话、历史、过程与中止交互 | `AssistantPage`、可嵌入 `AssistantPanel`、turn ID 时间线 |
| `apps/web/src/features/ai/ai-markdown.tsx` | 安全流式 Markdown | 同版本 `@ant-design/x-markdown`，HTML转义、媒体阻止、SQL复制/使用 |

Doca 是 TypeScript/Fastify/Mastra 宿主，本项目是 Go 主服务，迁移事件/工具/对话框架。文件编辑器、图片工作流、文档权限与 Doca 的数据库结构不属于监控任务，未引入其运行时。模型设置由 LightMoni 管理员明确填写，密钥使用主干加密函数存入后端 SQLite。

## 已实现接口与流程

构造：`assistant.New(shared.Dependencies) (*Service, error)`；注册：`Register(*http.ServeMux)`。在 `assistant_records` 建立模块自身表，主干负责传入同一 SQLite DB、Query、Catalog、Encrypt 与 Decrypt。

| API | 行为 |
| --- | --- |
| `GET /api/v1/assistant/config` | 返回 Base URL、模型名、enabled、has_key；不返回秘密 |
| `PUT /api/v1/assistant/config` | 仅管理员；密钥为空保留旧值，clear_key 显式移除 |
| `GET/POST /api/v1/assistant/sessions` | 当前用户会话历史、创建会话 |
| `GET /api/v1/assistant/sessions/{id}` | 当前用户会话、消息、持久事件 |
| `POST /api/v1/assistant/sessions/{id}/turns` | JSON `{text,context}` → `text/event-stream` |
| `POST /api/v1/assistant/sessions/{id}/cancel` | 取消该用户当前 turn，context 传到 provider 与查询 |

事件包含 sequence、session_id、turn_id、type、timestamp、data。类型包括 user.message、turn.started、step.started/completed、assistant.delta/message、tool.call/result、turn.completed/failed/cancelled。会话同一时刻最多一个 turn，冲突 409；未配置或停用 provider 返回 503。流式断开后重读持久历史，不自动重复发送提示造成二次模型调用。

提供 `list_tables`、`describe_table`、`run_query`、`draft_dashboard`。SQL 共用主干只读执行器；单次工具查询只有一个 refId，显式时间范围，10 秒截止，模型最多看到 1,000 行并标注 sample_truncated。64 KiB 工具参数、128 KiB 工具结果、256 KiB provider 请求、最多 8 步与 2 分钟 turn 边界均有明确错误。记录内容视为待分析数据，不能新增工具权限；没有外部请求或 shell 工具。

`draft_dashboard` 只生成草稿，不保存。前端显示标题、图表类型与可编辑 SQL，支持调用同一 `/query` 预览，用户点击自定义 Modal 中的“确认保存大盘”后调用正常大盘 CRUD。保存失败保留草稿，成功回显保存结果。AI 侧边面板可注入 `onDashboardDraft`、`onSQL` 与当前日志/大盘上下文。大盘最终 schema 需与 01 模块同步适配，不把前端成功点击当作最终数据保存验收。

## UI 设计与取证

沿用主干 oil-ui 方向：明亮工作区、深色导航、单一蓝色强调。助手的主动作是输入与发送，欢迎页提供创建大盘、分析日志、SQL 三个可编辑起点。历史在侧栏；当前表、service、时间在对话上方；过程可折叠，具体工具参数/结果可查；最终回答与草稿操作分开展示。所有选择、输入、确认均为共享 React/Ant Design 控件，没有原生 select、window.alert/confirm/prompt。

动效：新 turn 短距离淡入，工具执行与分析状态脉冲，快捷任务 hover 轻抬升；尊重 prefers-reduced-motion。具体视觉和动画证据必须由真实浏览器补齐，本任务文档不提供虚构截图、评分或实际模型连通证明。

## 验收

1. 管理员配置 provider；成员可使用且不能读取/修改密钥；未配置时说明不可用。
2. 真正兼容模型能列目录、读 schema、执行带时间过滤 SQL、基于结果分析与生成草稿；原始模型凭证由用户提供，不使用任何本机其他项目账号。
3. SSE 分片/中文/多个工具调用正确；步骤和结果可查；停止取消模型请求与数据库请求；断开、超时、非 200、错误 JSON、截断输出明确失败。
4. 同提示多个 turn 独立按 turn ID 排列；同会话并发返回冲突；保存并刷新/重启后历史可读，其他用户不能读取。
5. 日志注入文本不能触发任意 URL、shell、数据库写入或大盘保存；所有模型调用只暴露注册的 read/draft 工具。
6. 草稿可编辑、预览、确认保存，失败保留，保存后从真实 dashboard API 重新读取。
7. 1440×900、1280×800 与窄屏，键盘发送/换行、中文输入法、Modal 焦点、200% 缩放无遮挡；侧边模式不遮盖原页面操作。

## 已完成的真实验证与边界

- `go test -race ./internal/assistant` 已通过：兼容 provider HTTP/SSE fixture 的碎片工具循环、工具结果回传、取消直达 provider、并发 409、真实 SQLite 重启与主干加密适配、会话隔离、未配置 503、严格输入、提前 EOF 与秘密不泄露。
- `npm run typecheck` 已通过当时已有模块。全项目后续新增模块须再由主干集成验证。
- `node --experimental-strip-types --test src/features/assistant/assistant.test.mjs` 四项通过：turn 去重与最终文本替换、中文 UTF-8/CRLF 分片 SSE、未完成流错误、未配置 provider 明确失败。
- 加入 Markdown 后的一次全项目 typecheck 被其他模块正在写入的 `src/main.tsx` 与 `src/shared/SQLInput.tsx` 的 JSX 语法错误挡住；主干完成这些文件后应再次运行，不能用此前通过替代最新集成验证。
- 加入 Markdown 后，针对四个 AI TypeScript 源文件及其依赖执行独立 `tsc --noEmit --strict ...` 检查通过；全项目错误仍需主干处理。
- 尚未使用真实 provider 凭证；不把协议 fixture 当作真实模型验收。
- 应用入口、最终大盘 schema 与真实 Catalog/ClickHouse 联调由主干及 01 模块完成后复核；真实浏览器证据在集成阶段补齐。

参考： [本地 Doca AI 骨架](/Users/zhangsiwen/dev/dsh/doca/packages/ai-host/src/host.ts)、[Doca LICENSE](/Users/zhangsiwen/dev/dsh/doca/LICENSE)、[兼容请求参考](https://developers.openai.com/api/reference/resources/chat)、[工具调用协议](https://developers.openai.com/api/docs/guides/function-calling)。Doca 的实际复用依据是上述已检查的本地源文件，不以未核验远程仓库路径替代本地审计。
