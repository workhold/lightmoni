# 新存储与删除契约

固定业务根R=/var/lib/lightmoni-managed/operations/platform；应用R/applications/<application_id>/instances/<instance_id>，网站R/websites/<website_id>，网关R/gateways/<instance_id>。storage.layout_version=2。网站current→versions/<digest>，nginx.conf、metadata.json、auth-probe.json、ssl/<fragment>、auth/<fragment>、public/<fragment>同版本。网关只保存索引、非秘密网站版本映射；共享中心证书不属于网站物理清理范围。无旧目录迁移或双布局回退。

Agent新存储能力operations.platform.storage.v2；workload/gateway签名载荷携带storage_layout=2与application_id，website.remove携带website_id，不能传任意文件系统根。应用默认命名卷带应用和实例ID；外部volume/bind为显式覆盖。website.remove幂等返回website_id/removed/absent，所有权不匹配、路径不安全或活动网关仍引用时拒绝，不删除其他资源。

DELETE /api/v1/ops/resources/:id仍要求管理员与revision。应用返回200 deleted=true且remote_data_deleted=false，保留业务数据。网站若需物理清理，返回202 deleted=false与deletion进度；重复相同revision请求回读持久任务。未部署的网站可立即200删除。网站登记保留到所有宿主清理成功、DNS及引用检查通过，之后GET资源为404，执行历史和删除审计保留。失败/离线/权限撤销/unknown明确可见，unknown不自动写重试。删除中编辑/发布返回website_deletion_in_progress。

GET /ops/resources/:id/storage按20项分页，显示application_root/instance_root及网站root/current/config_file/version_root和SSL/auth/public目录。无新版回执时为null；清单不含配置正文、密码、哈希或私钥。回执维持60KiB上限，数组截断明确。
