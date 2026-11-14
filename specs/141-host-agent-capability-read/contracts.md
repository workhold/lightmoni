# 主机与 Agent 只读契约

## 新增能力

- `lightmoni_hosts_inventory`：hosts.read；按当前 host_ids 过滤，返回 `{machines,total,truncated,next_offset}`。
- `lightmoni_hosts_details_get`：hosts.read；`{id}` → `{machine}`，使用 assistantGet 安全视图。
- `lightmoni_agent_releases_list`：agents.read；安装级 `{releases}`，包含真实版本、架构、build 和 SHA256。
- `lightmoni_agent_installations_get`：agents.read；`{deployment_id}` → `{installation}`，按结果 machine_id 复验主机。
- `lightmoni_agent_updates_get`：agents.read；`{machine_id,update_id}` → `{update}`，保留原生升级/回滚/unknown 状态。

主机详细能力支持 host_ids；Release 目录 allHosts=true。全部 read，不授予预检、提案、审批或执行。旧 hosts_list/get 名称、Scope 和输出不变。

## 安全与状态

assistantSafe 清除 Host Key 字段；凭据只保留原 assistantGet 允许的非密元数据。安装 receipt 只含原阶段/Agent/enrollment 引用，维护视图不含 SSH 输出、秘密、控制/数据凭据或下载票据。

rolled_back 表示失败后恢复旧程序，不等于升级成功；unknown 需要人工核对。内部旧工具返回原外层形态，外部新增能力使用上述 data 结构。
