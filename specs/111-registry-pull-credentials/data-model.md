# Data Model

## ops_registry_credentials
id、name、registry（规范化精确host:port）、repository_prefix、cluster_ids_json、username、secret_cipher、revision、expires_at、revoked_at、created_by、updated_by、created_at、updated_at。
秘密仅AES-GCM密文，撤销清空。公开响应返回has_password和references（应用ID/名称），从不返回cipher/password。创建revision=1，编辑/撤销CAS递增。过期项不可用于任务。删除拒绝现行应用与已发布部署快照引用。

## application.spec.registry_credential_ids
最多20个唯一凭据ID；保存时验证存在和有效；派发时验证镜像与集群范围。不保存秘密。集群限制为空表示该应用所有部署集群。

## task.config.registry_authorizations
只包含id、revision、registry、repository_prefix及images。队列与领取时从应用当前授权重新计算并比较。独立POST jobs/:id/registry-credentials携带lease_id与精确image，验证后仅返回该镜像所需username/password；秘密不进入任务载荷、执行器journal或managed-jobs快照。绑定application_id/application_revision、cluster_id及已有租约/签名目标。

## 临时认证
每拉取一个原镜像创建0700目录、0600 config.json；仅一个auths条目。Docker Hub标准名称使用index认证键，物理仓库域名和显式端口使用镜像中的精确Docker domain。finally清理；崩溃时依托受管瞬时任务目录移除。只把路径放环境，不把秘密放命令参数或应用容器环境。
