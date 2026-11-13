# 运维只读契约

## 能力

- `lightmoni_operations_resources_list/get`：资源筛选/分页或准确 ID；网站/Compose 正文替换为安全摘要。
- `lightmoni_operations_runs_list`：可选 resource_id 和分页，返回 id/resource/revision/operation/state/时间/审批/job/review_url 元数据。
- `lightmoni_operations_runs_get`：准确 Run ID，沿用敏感日志省略和大列表裁剪。
- `lightmoni_operations_schedules_list/get`：计划列表或 `{schedule,fires}`；fires 读取真实 Run 状态，失败关联为 unknown。

全部要求 operations.read、admin、allHosts=true。Scope 不授予资源修改、提案、审批、取消、手动触发或 Schedule 写操作。

## 投影和状态

列表返回 `{items,total,offset,limit,has_more}`。资源列表 limit 1..50，Run/Schedule 列表 limit 1..100。敏感日志 receipt 置空并显式 receipt_omitted；超大详情只保留原生状态与 review_url，details_omitted 明确。

queued/running/unknown 不等于成功；Schedule disabled_reason 和 fire state 原样保留。服务读取不返回 static_files/Compose 正文、业务敏感日志或供应商秘密。

## 内部兼容

list_operations_resources 和 get_operations_run 返回原 data 形态；新 get_operations_resource/list_operations_runs/list_operation_schedules/get_operation_schedule 返回对应 data。旧 propose_operations_action 不对外开放。
