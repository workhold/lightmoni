# 拟议契约（未实现）

本文件供实现评审，不表示以下路由已存在。既有 Agent、SSH、SDK OTLP 路由及鉴权不改。所有新接口先校验管理员和同源写请求，不复用成员的 Agent 列表权限；API 版本前缀为 `/api/v1`。

## 主机视图与仅资产登记

- `POST /host-assets {name, description?, request_id}`：只创建 asset_only 资产，无地址、SSH 或 Agent。name UTF-8 最多 128 字节、description 最多 1024；request_id UUID。重复 request_id 返回原资源，相同 ID 不同正文 409。不自动创建凭据或节点。
- `GET /host-views?cursor&limit=50&include_removed=false`：管理员分页，返回 `items,next_cursor,evaluated_at`。每项 `host_ref,display_name,origin,scope,machine_id?,agent_id?,agent_state,ssh_state,revision,capabilities`。origin=`asset|ssh|agent_only`；scope=`host|container|unknown`。候选容器/未知 Agent 不能冒充 verified host。现有成员继续 `/agents` 只读，不请求此接口。
- 仅资产记录新增 SSH 时使用受验证的连接编辑流程，将 access_mode 原子改为 ssh；不能把未确认地址当可执行能力。旧 `/machines` 不返回 asset_only 记录；旧 DELETE 对 SDK 绑定有效的目标返回 409。

## SDK 关联

- `GET /sdk-instance-observations?cursor&limit=50&service=...`：管理员，固定近 24 小时有界范围。返回 `observation_id,selector:{key_id,service,instance_id},env,version,language,declared_host_id,last_event_at,last_received_at,current_host_ref?,source_state,truncated`，无 token、原始 resource 或业务日志。显示 Key 名称/截断 ID，实际 ID 由服务器保存在候选记录中。
- `observation_id` 为服务器随机短期引用，绑定用户、完整 selector 和观察快照，5 分钟过期、单进程最多 1000 个并淘汰最旧项；过期/重启后 409 提示重新获取，不绕过确认任意绑定。返回信息只是接收证据，不是物理位置证明。
- `POST /host-views/:ref/sdk-bindings {observation_id,expected_host_revision,confirm:true,request_id}`：确认手动归属。未知/过期候选 409，目标不存在 404，已归属其他有效目标或身份冲突 409；成功返回 binding 及新 revision。每台 100 条有效关系上限。
- `POST /sdk-host-bindings/:id/end {expected_revision,confirm:true,reason?,request_id}`：终止有效区间并审计，不删遥测或撤销 Key；重复同 request_id 返回原回执。
- `POST /sdk-host-bindings/:id/move {to_host_ref,expected_revision,expected_target_revision,confirm:true,request_id}`：事务关闭旧关系、创建新关系；保留 old/new 与时间。该动作不搬迁服务或修改 SDK 配置，只改变后续观测归属。
- Key 轮换用受审阅迁移提案列出旧/new key_id 与精确 selector；MVP 允许逐项重新关联，不承诺无感继承。受管部署归属使用审批快照中的 host、selector、Key ID 和 revision，禁止 AI 提交 confirm。

写入 API 共享 request_id 幂等表或审计回执：作用域 `(actor_id,operation,request_id)`，保存请求摘要与结果，至少保留 24 小时；并发重复只产生一个事件，相同 request_id 不同正文 409。服务重启后仍可回读。迁移与终止是有历史的变更，不能物理抹掉归属事件。

## 接入摘要与 SDK 详情

- `POST /host-access-summary {host_refs:[...最多50]}`：只读汇总，refs 必须来自管理员可见对象且长度/格式合法；未知项逐项 404，不将其当无数据。返回 `evaluated_at,policy:{sdk_fresh_seconds:90,max_future_skew_seconds:30},source_state,items`。
- 单项形状：`{host_ref,revision,agent:{state,last_seen?,evidence_at?,reason?},ssh:{state,last_check_at?,last_check_result?,reason?},sdk:{state,associated_count,recent_count:null|number,attention_count:null|number,source_state,evaluated_at,reason?}}`。查询失败/截断时 count 为 null，不填零；如保留缓存，返回 `stale:true` 与原 evaluated_at，不伪装新鲜。
- `GET /host-views/:ref/sdk-instances?cursor&limit=50&history=false`：按绑定区间查询实例，返回关联 ID/revision、service/env/instance/version/language、最近事件与接收时间、`state,reason,source,binding_started_at,binding_ended_at?`，无秘密。无摘要时可补一次近 24 小时且不早于关系开始的有界历史核对，补充“曾收到过”证据；不把旧心跳当当前活跃。未覆盖历史给出 `observation_window_not_verified`。SDK selfTelemetry 不可知时不返回已禁用结论。
- Agent state=`not_enrolled|online|heartbeat_overdue|removed|uninstalled|unknown`，安装 absent 仅是带 evidence_at 的补充证据；SDK state=`unassociated|awaiting_signal|reporting|heartbeat_overdue|unknown`，已知停报/时钟偏差/身份冲突为 reason；SSH state=`unconfigured|fingerprint_unconfirmed|credential_valid|credential_expired|unavailable`，最近检查单列。

查询超时、目录不支持、数据被截断分别返回可诊断 source_state；HTTP 成功但 source_state 非 complete 也不能显示“无实例”。中心使用自身 evaluated_at，不用客户端本机时间判活。读取不刷新凭据、不发 SSH、不改变 Agent 任务。

## 主机删除与关联并发

- `POST /host-views/:ref/deletion-plan {}`：管理员，仅主机资产，返回不超过 5 分钟的 preview，包含 host revision、当前绑定 revision 摘要、SDK 归属数量、既有连接/计划守卫、影响说明。
- `POST /host-views/:ref/delete {preview_id,confirm:true,end_sdk_bindings:true,request_id}`：全部匹配才在事务内终止绑定、保存脱敏审计快照和删除主机；已有 SSH/任务/卸载守卫继续生效。关联、Key 迁移或目标改变使 preview 失效 409，不静默扩大删除范围。
- Agent-only 只提供原有移除接入及历史，不能调用资产删除冒充远端卸载。关联 Agent/资产的聚合迁移必须显示 SDK 关系影响并事务更新，不能通过旧 agent-link 绕过：有关系时旧请求返回 409 并要求新预览。

没有新的“SDK 管理凭据”；公开 host_ref、客户端 host.id、绑定关系不能用于 SSH、Agent control/data 认证、任务派发或模型调用。
