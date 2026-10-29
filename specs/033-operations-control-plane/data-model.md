# Data model

ops_platform_resources: id PK, kind/name, revision, spec_cipher, status_json, created_by, authorized_by, created/updated；资源引用限制删除。status 不含秘密。
ops_platform_revisions: (resource_id,revision) PK、name、spec_cipher、actor、created_at；发布引用不可变历史版本，草稿更新不替换已授权版本。
ops_platform_runs: id PK, resource_id/revision, agent_id, action, state, payload_cipher, result_json, job_id, actor, dedupe_key UNIQUE, timestamps；同逻辑任务不重复入队，unknown 必须显式核对。
ops_platform_instances: id PK, owner_id, application_id/revision, agent_id, desired/observed generation, state/health/last_seen, reserved cpu/memory, address/port, local-data affinity。
ops_platform_ports: agent_id/protocol/port UNIQUE, instance_id；只有确认停止/删除才释放。
证书 spec 的上传材料随加密配置保存；ops_certificate_versions 另外存不可变 material_cipher、metadata_json，以 (certificate_id,fingerprint) 唯一去重。status 只返回 fingerprint/SAN/not_after/version；目标保存 desired/applied certificate version。配置文件跟随 application revision，初始化文件只首次写入，数据目录不随配置回退。

ops_platform_nodes: agent_id PK、node_json、last_seen；由只读 node.inspect 观察CPU/内存/地址/Docker能力，机器池可以显式覆盖。

ops_acme_accounts: resource_id PK、key_cipher、account_url、updated_at。ops_acme_orders: id PK、certificate_id/resource_revision/account_id/state、payload_cipher、timestamps，payload 包括CSR私钥、CA订单与授权上下文。ops_acme_challenges: owner_id PK、order_id、zone_id、state、updated_at，精确绑定本订单TXT归属。

ops_dns_observed: (zone_id,record_id) PK、name/type/value/record_json，全量分页查询缓存。ops_dns_owned: id PK、zone_id/owner_id/record_id/name/type/value/ttl/state/updated_at，自动化以保存的Record ID为边界；DNS记录ID为字符串，不丢失64位精度。

ops_cloud_certificates: id PK、credential_id/fingerprint/provider_certificate_id/state/updated_at。id 由提供商、账号身份和证书指纹派生，复用上传并以回读确认绑定，避免跨账号错误复用。

中心执行的 payload_cipher 保存 resource_snapshot 与 input，Agent执行保存完整冻结config；普通job不含PEM、云凭据或脚本。所有秘密列使用现有中心AES-GCM，公用status/result保存脱敏有界摘要。此版本直接建立新模型，不迁移旧网站/容器记录。
