# Contracts

- 主机容器按钮向既有 ManagedContainerDialog 传递 id/name/agent_id，使用 /machines/:id/execution-status 和 /privileged-execution；不调用旧 /ops/machines/:id/docker-jobs。
- 环境补装不修改 Agent 运行模式或权限；已有完整 Engine/Compose 的 CentOS 可验证，缺组件仍只自动补装 Ubuntu/Debian。
- 非零 SSH 错误 remote_exit_code 为整数/null，remote_reason_code 限白名单；不保存远端原始文本。
- 已派发部署仍 status=unknown，receipt 保留 bootstrap_dispatched、enrollment 关联和有限 diagnostic。原互斥与显式核对/结束契约不变。
- 生产中心 schema=2，原 schema=1 卷保留；不加自动迁移或兼容 SQL。单次运营重建保留既有管理员登录，不迁移主机/任务/作业记录。
- systemd 就绪探测接受三/四位版本号、常用版本后缀与单个有界发行版括号后缀；空值、多行、控制字符及不完整括号仍拒绝。格式有效不代替 system bus 和文件权限验证。
- 受管 workload 的 health.host 来自已预留服务端口的 host_ip；部署和巡检使用同一目标。缺省 IPv4 通配绑定探测 127.0.0.1，IPv6 通配绑定探测 ::1；非 IP 字面量拒绝，HTTP IPv6 地址加方括号。
- Demo Registry 的网络限制仅匹配原始目的地址 172.21.0.16、原始 TCP 端口 20000、conntrack ORIGINAL 方向；允许受信网段 172.21.0.0/20 后拒绝其他来源。不改变其他端口或回包方向，主机本地 OUTPUT 继续用于 OpenResty 和 Agent。规则由 Docker 启动前的专用 oneshot 单元持久应用。

- 应用 service_name 适用于 manual/managed 两种 deployment_mode；网站服务引用保存稳定 application_id 与 port_name，界面以展示名和 service_name 标识服务。手动 routing_mode 的 cluster_targets 可为 application 或 proxy；托管 routing_mode 由 service_application_id/service_port_name 生成 application 目标，不使用手工 URL，且不按应用 deployment_mode 过滤可选服务。无健康端点返回 503。
