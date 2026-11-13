# 任务创建与修改提案契约

`lightmoni_tasks_plan` 新增 operation=task.create/task.update：

- create： `{operation,task,reason,idempotency_key}`，task 为完整自定义脚本定义。
- update： `{operation,task_id,task,reason,idempotency_key}`，task 为与原定义合并的字段。
- 不接受 run_id 或外层 host_ids；目标从规范化 task.host_ids 读取。

tasks.propose 不变。返回仍为 awaiting_approval proposal/review_url，不能审批或直接执行。审批后 create/update 只改变任务定义，不创建执行。

有限 Host 授权要求 task.target_all=false、label_ids 为空且 host_ids 非空并全部授权；update 的 before/after 均满足。撤销、过期、降权或目标缩小时，创建与审批均 fail closed。

内部 propose_task_action 五种操作统一 Dispatcher；原 TaskProposalService 的类型、来源、调度、revision、owner 和人工审批不变。同 key 同输入返回原提案，异输入 detail_code=idempotency_conflict。
