# 设计

扩展现有 OperationsPlatformStore 的中心执行句柄，明确分离立即返回的 run 与完成 Promise；原 run() 仍等待完成。证书控制器统一创建持久执行与步骤追踪，HTTP 创建/issue/renew 返回句柄，内部网站签发保留等待。首次意图在 afterSave 事务内登记，创建后即调度，tick 补齐未启动意图；已启动重启结果未知，不自动重新发起。每证书互斥，执行绑定资源 revision/授权者，完成后沿用既有版本保存与分发。

新增 ops_platform_run_events：run、资源、单调 sequence、时间、阶段、事件状态和有界脱敏详情。进度单独持久化；GET run events 只读查询无需 ClickHouse，既有 system_log_outbox 将步骤作为同一系统事件投递到 lightmoni_log。日志产生端仅保存允许字段；已知秘密和 PEM、认证头、敏感键、URL 用户信息/查询在保存前去除。ACME 库抛出的 detail/message 不能再次被无原因的 CloudError 覆盖；清理失败不能掩盖主失败。

前端沿用 Ant Design：证书状态“申请中”使用 processing Tag，紧邻图标打开独立签发日志抽屉，选择历史回执，2 秒增量轮询；展示阶段时间线、DNS 等待次数、错误原因和旧日志说明。创建表单明确“保存并开始申请”的结果；请求成功即关闭表单，失败输入保留。页面存在申请中证书时加快状态回读，日志轮询只在打开时运行。

验证采用真实 Router/Auth/SQLite、可控 ACME/DNS 延迟/失败夹具：创建不被 gate 阻塞、阶段有序、失败原因保留、秘密不泄露、重复/恢复/撤权/revision、后台续期与网站兼容；系统日志 outbox 与 UI 中英文/窄屏/持续刷新/历史诊断回归。架构双端同步与回读证据同 PR。
