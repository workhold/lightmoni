# 契约

- `application.spec.ports[]` 继续使用 `{name, container_port, host_port, protocol, app_protocol, service?}`。网站可绑定条件仍为 `protocol === "tcp" && app_protocol in ["http", "https"]`，与部署模式、健康实例数量无关。
- 网站 `service_application_id/service_port_name` 和 `cluster_targets[].application_id/port_name` 的保存结构及服务端错误码保持不变。非 HTTP/HTTPS 端口只作为禁用选项解释已有声明，不可借此保存为网站上游。
- Compose 长格式 `ports[].app_protocol` 为已有配置输入。显式值（包括空字符串）优先于匹配旧端口；字段缺省时保留旧值，再回退空字符串。服务端继续验证允许值，不自动把未知 TCP 当作 HTTP。
- 单容器生成的 YAML 保留已声明的非空 app_protocol；表单转换遵循同样优先级。命名端口按已有容器端口、传输协议和组件归属匹配，修改应用协议不改变端口名或宿主端口。
