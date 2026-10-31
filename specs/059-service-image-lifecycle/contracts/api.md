# 目标契约（设计，尚未实现）

沿用管理员授权、JSON大小限制、revision冲突和审计。读接口分页，写入带expected_revision或冻结plan_hash；异步提交只表示排队，不表示就绪。以下路由为拟议契约。

| 操作 | 路由与输入 | 结果与约束 |
| --- | --- | --- |
| 新建发布 | POST `/api/v1/ops/applications/:id/releases`，revision、version_label、image/compose、source/credential_ref | resolving+run_id；全部服务解析后ready，不自动发布 |
| 版本列表 | GET `/api/v1/ops/applications/:id/releases` | 引用、digest、平台、来源、兼容及逐集群版本，无秘密 |
| 检查更新 | POST `/api/v1/ops/applications/:id/update-checks`，revision | check_id、成功/失败时间与候选；不改发布 |
| 商店概览 | GET `/api/v1/ops/catalog/updates` | 模板/应用版本、安装数量、受影响集群及兼容/检查状态 |
| 镜像策略 | PUT `/api/v1/ops/applications/:id/clusters/:cid/image-policy` | revision、mode/count/allow_upstream；保存有限预热授权，返回覆盖 |
| 镜像准备 | POST/GET `/api/v1/ops/applications/:id/clusters/:cid/image-preparations` | POST带release/revision；逐机run、来源、架构、就绪/错误/覆盖不足；不启停 |
| 升级预览 | POST `/api/v1/ops/applications/:id/rollout-plans` | release/cluster_ids/revision/strategy；冻结diff、冲突、镜像、停机/数据风险、回退、plan_hash/到期 |
| 确认升级 | POST `/api/v1/ops/rollout-plans/:id/execute`，plan_hash/revision | 逐集群rollout；配置/版本/授权变化409，不扩大集群 |
| 升级动作 | POST `/api/v1/ops/rollouts/:id/actions` | pause/resume/rollback/inspect+revision；unknown先核对，回退需兼容上一版本 |
| 更新策略 | PUT `/api/v1/ops/applications/:id/clusters/:cid/update-policy` | mode/range/window/timezone/batch/failure_action+revision；自动范围需管理员确认 |
| 镜像源 | GET/PUT `/api/v1/ops/registry-profiles/:scope/:owner` | Hub镜像、映射、代理/CA/凭据引用；unset继承、空清空；PUT只保存期望 |
| 主机实际设置 | GET `/api/v1/machines/:id/docker-settings` | 脱敏最终值/来源、期望/实际revision、能力及待维护状态 |
| Docker维护计划 | POST `/api/v1/machines/:id/docker-settings/plans`，revision | 配置diff、全部受影响容器、重启范围、plan_hash与有效期 |
| 应用设置 | POST `/api/v1/machines/:id/docker-settings/plans/:plan/execute`，hash/revision | run_id；CAS、互斥、受限命令与验证，不因保存自动执行 |

拟议Agent能力：image.resolve（读manifest）、image.prepare、image.inspect、image.cache_copy（限定源/目的地）、docker.settings_probe/apply/inspect。载荷绑定资源/集群/机器/Agent、release/image_set/profile revision、目的地、凭据范围与有效lease。无任意shell/URL下载/全机prune。

Docker维护主机写锁与应用部署/启停等Docker写动作互斥；派发和领取时重验成员、授权/策略revision、凭据、目的地与能力。临时Docker认证/代理文件权限0600且到期/完成清理。禁回源同时约束节点、镜像端点和缓存上游，普通Hub mirror fallback不作为隔离措施。

回执白名单：release_id、image_set_hash、profile_revision、machine/Agent、os/arch/variant、逐服务effective_ref/digest/image_id、source_kind(local/cluster_cache/configured_registry/upstream)、bytes_received、duration_ms、verified_at、health、error_code。全部服务身份及健康匹配才ready；禁止原始命令/stdout/stderr、秘密、认证头、userinfo URL及自由manifest注释。

错误区分：image_not_found/auth_failed/digest_mismatch/platform_unsupported/disk_insufficient/cache_unavailable/upstream_forbidden/preparation_stale；release_legacy_unresolved；update_source_unconfigured/check_failed/config_conflict/incompatible；docker_settings_conflict/unsupported/maintenance_required；execution_unknown。网络失败不等于无更新，缓存miss不等于认证失败。
