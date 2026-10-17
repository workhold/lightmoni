# Contracts

## Names

LightMoni Agent = 软件；执行节点 = 运行实例；节点管理 = 页面入口；任务 = 下发工作；任务类型 = host/probe/log（展示指标采集/服务拨测/目录日志）；任务标签 = 匹配条件；AI助手 = 独立网页对话能力。

## Center API

- GET/POST /api/v1/agent-task-labels，PUT/DELETE /api/v1/agent-task-labels/{id}。
- 标签形状 `{id,name,node_count,task_count}`，name 非空、去空白、最多128字节、唯一；被节点或任务引用时删除409，默认标签保留。
- GET/POST /api/v1/agent-tasks，PUT/DELETE /api/v1/agent-tasks/{id}。
- 任务形状 `{id,name,type,enabled,label_ids,config}`，type host/probe/log。config 使用当前RemoteConfig字段，各类型仅采纳其相关设置。label_ids去重，空数组不分发；任务名称最多128字节。
- PUT /api/v1/agents/{id}/labels，请求 `{label_ids:[...]}`，允许空数组。中心已分配标签不得被节点心跳覆盖。
- GET /api/v1/agents 增加 `label_ids/labels/task_ids/tasks`，保留旧字段及有效config；具体名称与前后端同步冻结。
- 读取需登录，变更需管理员；非法参数400，找不到404，配置冲突或仍被引用409。错误不得包含Key。

## Matching and compilation

启用任务与节点标签相交即命中，每个任务最多一次；所有操作事务内验证受影响节点，并对合并结果再次调用原有配置校验。

- host: host_table及collect_interval_seconds一致才可合并，collectors/process_names排序去重。
- probe: probe_table一致；拨测ID相同且参数相同则去重，不同则冲突。
- log: log_table一致；完全相同来源去重，同directory/pattern/recursive但from_beginning不同则冲突。
- 不使用任务隐含默认值覆盖其他类型的配置；合并后维持原有32进程/32目录/128拨测等上限。
- 无匹配设置host_enabled=false/logs_enabled=false/probes=[]；稳定内容hash作为revision，元数据变化亦纳入。

## Compatibility and migration

旧每组配置拆成同标签目标的host/probe/log任务（保留启用状态、原参数和表），旧节点只绑定该标签。只修改仍为系统原默认名的default标签显示名，用户命名保留。一次版本迁移不得在重启后复活已删任务。

保留 /agents 路由、--group-id、group_id注册字段及GET /agents/{id}/config；初次注册group_id解释为初始标签，旧节点忽略新增元数据继续执行flat配置。旧组写接口必须明确返回迁移提示或转为有效新任务写，不能成功但不生效；旧GET供历史安装兼容。
