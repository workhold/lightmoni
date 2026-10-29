# Runtime contracts

与 plan.md Shared Internal Contract 保持一致。所有 /ops 管理 API 仅管理员，400 参数/能力错误、403 权限、404 资源、409 revision/引用/冲突，API 错误无秘密。
GET /ops/overview → {resources,agents,runs,capabilities,total,limit}（最多1000资源的页面摘要）；GET /ops/resources?kind=&offset=0&limit=1000 → {resources,total,offset,limit,next_offset}；POST {kind,name,spec} → {resource}；PUT /:id {revision,name,spec} → {resource}；DELETE /:id {revision}。领域内部 list 无展示截断，引用/删除校验扫描完整集合。
POST /ops/resources/:id/actions {revision,confirmed:true,action,input:{}} → {run? , result?}；动作名由领域声明，未知拒绝。GET /ops/runs?resource_id= → {runs}。
私有 Agent operations URL 复用当前路由，domain=platform 时转入 PlatformStore resolver，仍校验 control 身份、活动 job lease、resource/operation/node/expiry。
Agent 操作由 operations.platform capability 声明，原始脚本和证书只在私有载荷；成功必须是实际现场证据。脚本 task=hook.run 包含 script/interpreter/timeout_ms/env/certificate files context，环境只取显式字段和最小 PATH，不继承中心凭据，不返回 stdout/stderr；timeout 或不确定结果为 unknown。
DNS CRUD 端点由 DNS 控制器提供；provider_record_id 和 observed value 回读后变更，自动 ownership 不覆盖外部记录。证书分发云适配器按提供商固定 endpoint/action/schema，不允许任意 URL 注入云密钥。

GET /ops/resources/:id/records?offset=0&limit=20&keyword=&type= → {records,total,offset,limit}，查询全量 DNS 观察缓存，资源 status 中只保留前100条。记录变化通过 actions 的 create_record / update_record / delete_record / set_record_status 操作；新增/修改的 input.record 提供记录字段，删除/启停的 input.id 指定记录ID，input.enabled 指定启停。记录ID按字符串保留精度。

Agent task 还包含 node.inspect（CPU/内存/IP/Docker 容量探测）；workload.*、gateway.*、certificate.*、hook.* 的完整冻结契约见 plan.md。unknown 不自动重放，目录/脚本回读不自动清除节点持久未知写锁。
