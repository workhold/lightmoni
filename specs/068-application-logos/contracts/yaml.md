# Application YAML

configuration_mode=form|yaml 为展示/输入意图，不是 Agent 能力。compose 模式高级输入 spec.compose 为 YAML 字符串或对象；container 高级输入 spec.configuration_yaml 为 services.app 单服务 YAML。单容器仅支持已有 image/command/entrypoint/environment/network_mode/networks/restart/user/working_dir/read_only/ports 字段；平台挂载、健康及部署信息继续由原字段管理，不静默丢失其他键，多服务用 Compose 类型。

中心在 preserveEnvironment 前规范化 YAML 的字面环境变量，原服务/键的 [redacted] 恢复旧值，新服务/键占位返回 environment_value_required。不保存或公开未经安全投影的 YAML 源文本；读取后由 Web 渲染规范 YAML。

高级 ports 从 services.*.ports 提取 target/protocol；不把 expose 变成发布。托管无视 published 并由平台分配，保留相同端口旧/表单 host_ip；手动使用 YAML published。旧 name/app_protocol 通过 service/target/protocol 保持，新端口自动命名。所有映射仍经过既有资源、端口、网站引用和执行校验。普通表单和商店配方沿用顶层 ports。
