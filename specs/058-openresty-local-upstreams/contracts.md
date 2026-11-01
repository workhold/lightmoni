# 契约

- `gateway.apply` 的既有 `sites[].locations[].upstreams` 结构不变。平台生成应用目标时，按目标网关机器逐端点选择 `scheme://host:host_port`；同机 host 固定 `127.0.0.1`，异机 host 为发现 IP，IPv6 带方括号。host_port 是所选命名端口的宿主端口，不是容器端口。
- 应用目标来自同集群新鲜健康端点；不新增跨集群回退、不优先或剔除远端健康端点。无端点仍 `unavailable=true`，渲染为 503。
- `target=proxy` 的显式 URL 保持用户配置。发现 API 的 `ip`、`machine_id`、`agent_id` 等字段不变；按集群的配置预览仍显示发现地址。
- 已发布网站修订、域名范围、Agent control/job lease、nginx 检查/重载/验证/回滚与每实例完整包签名契约不变。旧 Agent 无需新协议支持。
