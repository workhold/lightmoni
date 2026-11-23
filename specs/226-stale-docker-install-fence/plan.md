## 设计

- 服务启动时扫描 `machine_docker_installations` 中仍处于 `running/unknown` 的记录，联查当前主机 Agent ID；旧身份记录更新为固定失败收据。
- 只读核对入口在做凭据选择和 SSH 前先复核当前 Agent ID 与创建时目标修订，变化即返回 `failed/docker_install_target_changed`。
- 后台安装与核对异常处理区分 `docker_install_target_changed`，避免把已知目标变化误写成 unknown。
- 本变更是生命周期栅栏的错误恢复修正，不改变组件职责、存储边界或部署拓扑；`docs/system-design.md` 不适用。
