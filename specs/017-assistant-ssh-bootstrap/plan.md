# 设计

1. 提取共享 SSH transport：临时 0600 私钥、精确 SHA256 主机公钥 pin、仅信任匹配的公钥、忽略全局/用户 SSH 配置、禁转发/代理/交互认证、限时与取消、退出清理。
2. 固定 shell 产生严格白名单的键值结果。后端解析为枚举/布尔值，不转发 stdout/stderr；预检错误映射固定错误码。持久化 machine_ssh_checks 保存操作者、时间、目标快照及结构化回执。
3. HTTP 与 AI 工具共用 checkSSH/createPlan；检查及安装共用单机互斥。计划引用预检，绑定目标快照及凭据；apply 校验后沿用 enrollment 安装流程。
4. 主机页新增检查与结果展示，部署表单先检查再生成计划；解析 machine/deployment query 打开既存提案。助手展示双语工具名及“审阅部署计划”按钮。
5. Docker 运行镜像安装 openssh-client。覆盖权限、秘密隔离、参数拒绝、主机 pin、失效/竞态、取消及完整 HTTP/工具链路；生产前端隔离验收。
