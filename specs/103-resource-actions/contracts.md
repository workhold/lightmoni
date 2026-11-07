# 契约

- DELETE /api/v1/ops/resources/:id 保持请求 revision 和返回 remote_data_deleted=false，既有失败码保持兼容。
- 历史空容器证明只用于解释已退役实例，不授权远端删除，不忽略网站引用、持久化数据或执行围栏。
- 恢复回执沿用 operations.platform.instance-recovery.v1；不信任单独的前端状态或伪造 observed_json。
- /applications/:id/monitoring 和 /websites/:id/monitoring 路由保持；图标按钮名称随语言切换，监控不触发部署。
- 危险菜单需确认后才调用原回调。发布、升级、终端、配置等仍调用原流程。
