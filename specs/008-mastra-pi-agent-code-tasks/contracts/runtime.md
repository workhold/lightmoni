# Runtime contract

## 开关与权限

只有配置 `LIGHTMONI_CODE_WORKSPACE` 才注册 `code_task`。`GET /api/v1/assistant/config` 增加 `code_tasks_enabled`；只对管理员返回 true，并提供默认相对工作区 `code_workspace: "."`，不公开主机根路径。代码任务所有 HTTP 接口均要求管理员；记录再校验创建者或管理员身份。普通成员保持监控查询与大盘草稿能力。

## Mastra tool

`code_task` 输入：`{ task, workspace, allowed_paths?, allowed_commands?, max_steps?, timeout_ms? }`。会话中服务端以用户选定的 `context.code_workspace` 覆盖模型传入的 workspace。可选路径与命令只能收窄权限；执行限制上限由服务端校验。

工具回执包含任务 ID、状态、摘要、有限文件/步骤/检查、`diff_available`、`changed_file_count` 和期限。完整 diff 保留在任务资源中，不传入 Mastra 的有界工具管道。`awaiting_approval` 必须提示用户审阅并在网页审批，模型不能调用 apply 工具。

## Routes

- `POST /api/v1/assistant/code-tasks`：执行预览任务，201 返回完整结果；同步请求，断开请求会取消。
- `GET /api/v1/assistant/code-tasks/:id`：读取当前状态和完整 diff。不可见、过期或不存在返回 404。
- `POST /api/v1/assistant/code-tasks/:id/apply`：用户显式应用已保存预览；成功返回 completed。重复已完成操作幂等；过期、冲突或文件已变更返回 409。
- `POST /api/v1/assistant/code-tasks/:id/cancel`：取消 running 任务，返回 `{cancelled:boolean}`。已结束任务返回 false。

未配置工作区返回 503；非管理员返回 403。结构/范围输入错误返回 400；模型、检查或输出验证失败由任务 failed 状态表达。语义路径预检失败返回通用执行错误，不暴露主机路径。接口不返回 API key、进程环境或原始供应商错误。

## 使用配置

```sh
LIGHTMONI_CODE_WORKSPACE=/srv/lightmoni-code-workspaces
LIGHTMONI_CODE_CHECK_COMMANDS='["node --check app.js"]'
```

第二项可省略，默认为 `[]`。工作区是运维人员授权共享给模型的源码，不可直接设置为服务数据、数据库或生产部署目录；检查命令在中心服务身份下运行，仅用于可信源码。
