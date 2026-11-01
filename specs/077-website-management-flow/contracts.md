# 契约与状态规则

- 只读数据继续来自 `GET /api/v1/ops/overview`。新页面不新增 API，不根据本地点击推断上线或 DNS 成功。
- 网站发布/检查/停用继续向 `POST /api/v1/ops/resources/:id/actions` 发送 `{revision, confirmed: true, action, input: {cluster_id?}}`；用户点击入口只打开审阅，不发送请求。关闭、取消不写入；提交期间防重复。
- 入口设置继续 `PUT /api/v1/ops/resources/:id`，发送编辑开始时的 name/revision/spec，只替换匹配 cluster_id 部署的 gateway_domain/gateway_dns_zone_id。自行维护时移除 gateway_dns_zone_id；自动托管必须显式选择 zone。失败不改变输入，版本冲突不重放或静默合并。
- desired_revision 为 0/缺失表示未发布；有历史发布但 disabled 表示停用。unknown、失败、部分发布单独显示。active 不代表所有目标同步；全部目标成功需 synchronized/实际回执支持。
- 网站绑定的 dns_enabled 管理网站 CNAME/A/AAAA；OpenResty 部署的 gateway_dns_zone_id 管理入口 A/AAAA，两者互不代选。入口自行维护不直接阻止网站 CNAME，但页面说明用户需自行保证目标域名有效。
- DNS eligibility 仅为资格；`dns[].verified` 与 dns_updated_at 表示最近厂商回读，不能宣称公网传播或当前未发布配置已同步。未发布先提示发布，不能笼统显示等待健康入口。流量关闭、服务后端未就绪、缺入口域名、入口健康待定、厂商失败分别说明。
