# 契约

## Task

`script={runtime:'shell'|'node', code, timeout_seconds, max_output_bytes, args?:string[], cwd?:string}`。args 最多32项、单项最多1024字节、总8KiB，不接受NUL；cwd为可选远端绝对目录，最多4096字节。空新选项不要求v2；非空args/cwd需要 `task.script.v2`。快照可扩展保存 `task_revision`、`execution_policy`，重试沿用已审阅快照。

`schedule` 按 mode 校验，仅接受该 mode 的字段：

- `continuous`：内置采集专用。
- `once`：脚本手动派发（保留原含义）。
- `interval`：`interval_seconds` 为10..2592000。
- `at`：`run_at` 为明确带时区的 ISO 时间，规范化成 UTC；新建或改计划须是未来时间，已消费原计划允许保留和编辑其他字段。
- `cron`：`cron` 为五段表达式，`timezone` 为有效 IANA 时区，不支持秒级 Cron；服务端预览未来5次。遵循固定解析器的 DST 规则并用测试明确实际时间。

`execution_policy={max_concurrency:1..100(default10),queue_timeout_seconds:10..86400(default3600),retry_count:0..3(default0),retry_delay_seconds:10..3600(default60)}`。重叠处理固定 skip、错过计划不补跑。字段仅作用于脚本，内置任务不接收不适用策略。

## API

`POST /api/v1/task-schedules/preview`，平台管理员登录，输入 `{schedule}`，返回 `{schedule, next_runs:string[], timezone}`；最多5次未来时间，手动/持续为空，at最多1次。预览不保存任务或派发。

原任务 CRUD、AI 提案和 dispatch/claim/result 路径保留。上传在浏览器读取为代码，无二进制上传/执行接口。创建/修改与批准时都由后端校验完整 Task，计划和选项纳入 revision。客户端代码不可作为权限来源。

计划执行仍创建每主机 TaskRun，真实运行状态以远端回执为准。自动重试只针对明确失败、有重试授权、版本与目标仍有效的运行，沿用快照、生成新ID并关联retry_of，不复用已完成run。取消、unknown、租约过期、队列过期、控制丢失均不自动重试。
