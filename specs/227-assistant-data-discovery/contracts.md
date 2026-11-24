# 工具契约

- 通过 Capability Dispatcher 注册的 list_tables、list_tasks、list_managed_machines 支持 offset 和 limit，结果通过 next_offset 指示下一页，null 表示完成。分页按当前目录顺序读取，目录在两次调用之间发生编辑时应重新读取。
- 遥测目录保留 12 KiB 预算。单独超过页预算的服务列表可以省略，表字段和服务可通过 describe_table 查询。MCP/HTTP 默认目录保留列投影。
- get_managed_machine 对助手声明 machine_id，通过 Dispatcher 以 id 调用。列表和详情保留现有数据字段及权限。

- 静态工具定义的 ASCII 字母数字序列按每三个字符预估一个 token，标点及非 ASCII 内容按 UTF-8 字节计。仍保留现有轮次和请求预算。
- 工具卡片显示实际本页长度。正数 next_offset 表示还有下一页，结果通过原始回执查看。

- 工具回执中的提案审阅地址可以位于顶层、proposal 或 run。Web 卡片仅将当前站点的审阅地址转换为站内入口，执行仍由原生审批页处理。
