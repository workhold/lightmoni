# 数据与接口契约

## 集中连接凭据

- GET /api/v1/connection-credentials：管理员读取公开目录。字段 id、name、method、secret_fingerprint、retention、expires_at、status、hosts[{id,name}] 及生命周期时间；不含任何密文、私钥和密码。
- POST /api/v1/connection-credentials：{name,method,secret,retention,expires_in_seconds?,confirm_managed?,confirm_permanent?}；新增或复用，响应公开目录项及 reused。仅真正可解析私钥可新入库。
- PUT /api/v1/connection-credentials/:id：{name} 修改名称。
- POST /api/v1/connection-credentials/:id/revoke：{confirm:true}，全局撤销并清除秘密，影响全部主机绑定。
- POST /api/v1/machines/:id/credentials：可提交 {connection_credential_id,make_default?:true} 绑定已有项，也可提交新增材料；响应包含稳定主机绑定 credential_id、中央 connection_credential_id 与公开元数据。绑定不重复保存密文。
- PUT /api/v1/machines/:id/default-credential：{credential_id}，只接受本主机有效绑定。
- DELETE /api/v1/machines/:id/credentials/:credentialId：解绑本主机，不撤销共享中央项。
- 主机 summary 新增 default_credential_id；主机凭据目录新增 connection_credential_id、name、is_default。省略 SSH credential_id 时使用默认绑定，失效不回退；显式传入仍须校验所属主机和有效期。

## 主机网络

Agent register/heartbeat 可带 network_addresses:[{interface,address,family:'IPv4'|'IPv6',scope:'private'|'public'|'link_local'|'loopback'}]。服务端校验/规范化 IP 并自行确定类别，最多 64 条。不接受正文指定平台来源 IP；未提交网络字段与提交空快照含义不同。

主机 summary 新增 network:{addresses,private_ips,public_ips,observed_at,source_ip,source_observed_at,source_kind:'direct'|'trusted_proxy'|'unavailable'}。addresses 为规范化网卡列表；空数据保留空数组与空字符串，界面显示待发现。network 只来自当前合法绑定的 Agent；数据以观测时间说明新鲜度。

LIGHTMONI_TRUSTED_PROXIES 是可选代理 IP/CIDR 目录，默认为空。仅在 socket 对端可信时使用合法的 X-Forwarded-For 链，从右向左剥离可信代理；未经配置的转发头不能影响来源记录。内网地址也是有效连接来源，不将其错误标为公网。

手工新增同钥的主机绑定仍按本次明确期限并与中央项取较短值，不能因永久源去重而扩大本次6小时授权；显式选择已有库项才继承库项期限。one_time 密码不得跨主机共享，消费后中央秘密与绑定一起失效，不能重绑。不可解密/解析的旧项隔离为不可用，有限期限仍按原时间清除。
