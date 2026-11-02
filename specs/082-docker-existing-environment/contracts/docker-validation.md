# 当前契约

- POST /api/v1/machines/:id/docker-installations 的人工管理员确认、幂等请求与凭据字段保持不变。
- 主机 Linux/systemd 与当前架构有效，已有 Engine CLI 和 Compose 插件时，发行版不参与包安装准入；不访问软件源，现有服务及依赖验证成功才返回 succeeded / verified / 空 code。
- Engine 或 Compose 缺失且发行版非 Ubuntu/Debian：failed / checking_system / docker_install_unsupported，不调用软件包管理器或启用服务。
- 服务或最终依赖验证失败保持现有静态原因码；普通 Agent 无 Docker 授权。
- machine.docker_environment 继续只来自现有独立执行器签名观测；executor_observation_required 不能解释为 Docker 缺失，SSH 安装/验证回执不替代该字段。
