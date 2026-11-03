# Contracts

- 主机容器按钮向既有 ManagedContainerDialog 传递 id/name/agent_id，使用 /machines/:id/execution-status 和 /privileged-execution；不调用旧 /ops/machines/:id/docker-jobs。
- 环境补装不修改 Agent 运行模式或权限；已有完整 Engine/Compose 的 CentOS 可验证，缺组件仍只自动补装 Ubuntu/Debian。
- 非零 SSH 错误 remote_exit_code 为整数/null，remote_reason_code 限白名单；不保存远端原始文本。
- 已派发部署仍 status=unknown，receipt 保留 bootstrap_dispatched、enrollment 关联和有限 diagnostic。原互斥与显式核对/结束契约不变。
- 生产中心 schema=2，原 schema=1 卷保留；不加自动迁移或兼容 SQL。单次运营重建保留既有管理员登录，不迁移主机/任务/作业记录。
- systemd 就绪探测接受三/四位版本号、常用版本后缀与单个有界发行版括号后缀；空值、多行、控制字符及不完整括号仍拒绝。格式有效不代替 system bus 和文件权限验证。
