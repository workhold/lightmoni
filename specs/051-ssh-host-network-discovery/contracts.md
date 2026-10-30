# 数据与接口契约

- POST /api/v1/machines/:id/ssh-check 保持请求、权限和凭据选择不变。SSHCheckResult 增加 discovery:{status:'succeeded'|'unavailable',hostname:string,addresses:HostNetworkAddress[],observed_at:string}；失败仅返回固定状态和空数据，不保存原始 stderr。旧记录未带 discovery 时界面显示未发现。
- 主机 network 保留 addresses/private_ips/public_ips/observed_at/source_ip/source_observed_at/source_kind，新增 observed_via:'ssh'|'agent'|'unavailable'、hostname:string；主机名保留为独立观测元数据，不能改写用户 name。网卡和平台来源必须各自验证所属主机、SSH 目标代际或 Agent 身份，不能因新增 SSH 来源放宽 Agent 关联查询。
- machine_network_observations 原表原位增加采集来源、SSH 目标代际及必要的观测身份字段；历史 Agent 行按原绑定规则迁移，不重新激活旧 Agent 或伪造时间。
- 同一主机的合法成功网卡快照按实际采样时间更新；Agent 后续认证上报接管更新。失败保留先前成功数据，明确空成功快照清空网卡。地址快照与平台来源独立失效，SSH 不填充或重标记平台观测来源。
- SSH 输出核心枚举/布尔检查保留严格格式；可选发现区块有明确字节和条数上限，超过上限仅表示发现不可用。远端 hostname/IP/网卡名称一律视为不可信元数据，经规范化后才进入响应和存储。
