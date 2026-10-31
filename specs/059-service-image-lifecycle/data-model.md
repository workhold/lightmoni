# 目标数据模型

均为拟新增/扩展对象，不是已有数据库或接口。

| 对象 | 字段与约束 |
| --- | --- |
| application_releases | id、application_id、唯一version_label、config/template revision、加密配置/secret_refs、image_set、state、actor；ready不可变；逐服务source_ref、index/manifest/platform digest、os/arch/variant |
| cluster deployment扩展 | desired_release_id、previous_successful_release_id、policy_revision；保留application+cluster键，期望与运行版本分开 |
| image_preparation_policies | application+cluster唯一、on_demand/standby/all_eligible、standby_count、allow_upstream、并发/保留/空间策略、revision；新托管默认standby=1，旧部署显式启用 |
| node_image_preparations | machine/Agent、release、platform、image_set_hash、profile_revision、state、observed_image_ids、source_kind、bytes/duration、verified_at、error_code、run_id；上述身份参与去重，换Agent使旧ready失效 |
| registry_profiles | scope(global/cluster/machine)、owner、revision、受管字段、hub_mirrors、source_mappings、proxy/CA/credential_refs、no_proxy；presence表示继承，显式空清空，数组整体覆盖 |
| registry_authorizations | registry/repository、application/cluster、credential_ref、revision、expires_at；profile继承不扩大镜像读取范围 |
| catalog releases | template_id+revision不可变、application_version、channel、排序/semver、镜像集合、参数schema、兼容/迁移/回退声明、changelog、最低Agent能力 |
| update_sources/checks | fixed/catalog/manifest/tracking_tag、受控endpoint、channel、credential_ref、最近检查/成功/下次时间、result、candidate、error_code；未知与无更新不同 |
| update_policies | application+cluster、manual/notify/automatic、范围、IANA时区/窗口、批次/最大不可用/失败行为、actor、authorization_revision、enabled；撤销使未执行动作失效 |
| rollouts | application/cluster、from/to_release、expected_revision、plan_hash、strategy、policy_revision、state、逐实例run/receipt；每cluster最多1个活动rollout |
| docker_settings_plans | machine/Agent、profile_revision、原文件hash、新鲜影响清单hash、preflight_expiry、受管diff、私有backup_ref、restart_required、state、actor、run_id |

领域状态：release=resolving/ready/blocked；准备=queued/resolving/pulling/verifying/ready/failed/stale；检查=unconfigured/checking/up_to_date/update_available/blocked/check_failed；rollout=planned/preparing/awaiting_approval/running/verifying/succeeded/paused/rolling_back/rolled_back/failed/unknown/cancelled。Agent底层job沿用现有状态，以上为领域投影；automatic仅在已确认策略内执行。

回执必须匹配release、image_set、平台、机器/Agent及profile才更新ready/运行版本。过期回执只存历史；unknown持锁等待inspect，不清理未知引用。UI只返回脱敏摘要，旧模板/发布/回退配置用秘密引用，真实材料由私有载荷按当前授权解析。
