# Data Model

- OpenResty deployment：gateway_domain、gateway_dns_zone_id、gateway_domain_generated，平台生成并持久化稳定选择。
- application status.quick_install：domain、website_id、certificate_id、gateway_id、state、error、updated_at；awaiting_backend → publishing → verifying_dns → ready；失败failed，未知unknown，重试沿用引用。
- SDK：应用保存受控Key引用，逐实例载荷解析活动Key与中心地址，身份来自应用/集群/机器/实例。公开环境仍全量脱敏，身份标签不授予资产权限。
- registry：唯一registry宿主映射→5000，全局一个固定机器部署、单一可写仓库与存储，额外仓库由用户自行安装。
- 不新增影子健康真相，继续采用现有部署/证书/DNS回执。
