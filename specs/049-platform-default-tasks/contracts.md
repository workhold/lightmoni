# 契约

## Task 与初始化

Task 不再含 template_id。origin 保留 builtin/custom 存储值，展示为平台默认/用户任务；仅服务端初始化可产生 builtin。平台默认 host/probe/log 使用稳定 ID，enabled=true、target_all=true、continuous；probe.probes=[] 与 log.log_sources=[] 返回 waiting_config，Agent 不执行对应空配置。

一次性迁移只补齐缺少的默认类型，已存在平台默认定义原样保留；重启不反复补齐。历史主机覆盖、任务引用和 TaskRun 不重写。移除模板字段导致的定义版本变化使旧预览及旧版本自动重试按现有校验拒绝；普通已排队或运行中的执行继续沿用已审阅快照，不重放。

## API 与 AI

- GET /api/v1/agent-tasks 返回持久化统一目录；不再提供 /api/v1/task-templates。
- POST /api/v1/agent-tasks 仅接受 type=script，origin 省略或 custom。非脚本新建、builtin 伪造、已移除模板字段均拒绝，返回400。
- PUT /api/v1/agent-tasks/:id 保留已有 origin/type；不得通过省略或更改来源/类型提升权限。已有 host/probe/log 用户任务仍可调整参数、目标和启停。
- DELETE /api/v1/agent-tasks/:id 对 builtin 返回409；custom 沿用原删除及运行中保护。
- 人工及 AI 使用同一 prepareTask/task 校验；AI 支持更新默认任务与创建脚本，始终先提案后批准。
- 旧 /api/v1/agent-groups 写入口仅维护标签名称；任何 config 写入返回410，不能绕过任务目录创建原生任务，删除也不能隐式删除任务。
- 原 schedules/preview、dispatch、claim、result、单机 override 契约不变；基础控制协议独立于任务开关。
