# 契约

- certificate spec.domains 保留数组结构；新建仅 1 项，允许 *.example.com。多项报 certificate_single_domain_required。历史多项更新只能保留规范化后原集合，读回名称为域名集合，不静默选择第一项。新证书 name 可省略或忽略，由中心派生；其他资源名称要求不变。
- certificate_target directory 仅接受 agent_id 或 cluster_id 之一；两者都填/都空拒绝 certificate_directory_scope_required。hook 仍要求 agent_id，拒绝 cluster_id；cloud 契约不变。目录与权限校验不变。
- 既有 POST resources/:id/actions 的 sync/retry/inspect，集群目录返回 {runs:[逐机器 run]}，单机/cloud 返回 {run} 不变。集群 status.machines 提供 machine_id、agent_id、run_id、state、期望/已应用版本和安全错误；聚合 applied 仅全部符合时成立。
- 空集群或成员尚无有效 Agent 时 409，派发前验证全部成员。配置保存可等待成员接入；自动轮次记录错误，不伪装成功。成员身份换绑或离开后私有载荷报 403；管理员撤权与配置 revision 守卫不变。
- 默认同步逐机器幂等，不自动重放失败/unknown。retry 只重试失败成员；unknown 没有成功现场证据时拒绝。inspect 不携带证书材料到节点，核对现场版本与指纹。
- 不新增节点任务类型或公开秘密接口；PEM/私钥仅放入现有加密载荷与受 lease 保护的下载。证书查看下载、旧单机/云/脚本目标接口保持兼容。
