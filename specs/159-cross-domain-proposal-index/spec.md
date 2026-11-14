# 159 · 跨领域提案索引与统一查询

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～158 和全平台能力开放 Goal，本切片开始 Slice 4：跨领域提案索引与只读查询。PR #208～#212 和依赖 PR #213 均未获本轮合并授权，本切片 stacked 在 #213 上并独立创建 PR，不自动合并。

## 需求与范围

1. 新增 capability_proposals 索引，关联 domain/native_id、capability、owner、source、operation、native_state、review_url 和可选 host_id；只存投影，不保存第二份提案正文或第二套审批状态机。
2. 任务、告警、服务部署、运维和 Agent 首装提案在与原提案/幂等相同 SQLite 事务中写入索引；索引冲突失败关闭。
3. 新增 `proposals.read`、`lightmoni_domain_proposals_list/get`，支持 domain/state 过滤和有界分页；原生记录为事实来源，读取时刷新真实状态与审阅地址。
4. 通用状态只区分 awaiting_approval/completed，native_status 保留领域真实状态；排队/执行中/unknown 不映射为成功。
5. 每次读取同时要求 proposals.read 和对应领域 Scope；Host 范围凭据只能看到匹配的 host_id，安装级领域仍要求 allHosts。跨用户提案不可见。
6. 不开放审批、执行、通用 Apply、OpenAPI/Bearer、服务主体或持续授权；执行索引后续独立切片。

## 非目标

- 不迁移或改写原生提案，不保证历史未索引记录全部回填。
- 不把索引状态当成真实执行结果，不宣称 OpenAPI、普通程序 Bearer 或完整 Slice 4 已完成。

## 验收

1. 各领域创建提案时同事务生成索引，同 key 回放不重复，审批后 list/get 返回原生最新状态。
2. 领域 Scope、owner、Host 范围、domain/state 过滤和分页生效，无敏感正文泄漏。
3. 内部助手、MCP 和会话 HTTP 复用同一查询；官方 MCP 客户端可发现并读取索引。
4. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
