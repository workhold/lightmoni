# 中心内外网地址同步

管理员在「管理后台 → 接入配置 → 上报地址」登记完整URL，内网地址填写实际IP及端口，例如 `http://10.0.0.8:8080`；IPv6使用方括号。用途选择「内网优先」或「公网引导 / 备用」，默认引导必须为公网入口，至少保留一个公网入口。HTTP表示显式使用受信明文链路；生产HTTPS须有匹配地址的有效证书。

业务SDK与Agent分别直连中心。业务SDK不再连接Agent，Agent的 `/v1/logs`、`/v1/metrics`、`/v1/traces` 与 `/v1/sdk-config` 已移除。Agent内部采集仍经进程内exporter进入自身持久队列；本地监听仅提供healthz/status诊断。

将SDK的 `LIGHTMONI_ENDPOINT` 或Agent的 `endpoint` 配置为稳定公网引导URL。客户端在首个请求前查询中心地址清单，优先探测内网；运行时每30秒或下一次发送前刷新，采样配置、自监控和停报开关不关闭地址同步。内网可达时，SDK配置/上报和Agent心跳、配置、任务通道及下载共用内网入口。当前Agent使用HTTP轮询，没有另建WebSocket协议。

管理员修改内网IP或端口后，无需重发应用。客户端先通过已选入口读取更新，旧入口不可用时回到引导地址查询。发现地址必须属于同一个center_id；刷新已发现入口前重新进行无凭据身份检查。探测不发送SDK Key或Agent凭据，不跟随重定向，不关闭TLS验证。身份标识用于误配防护，不替代HTTPS身份认证。

浏览器SDK还受浏览器的跨域、混合内容及私网访问规则约束；内网入口须满足这些访问条件，不能仅凭操作系统能连通就认为网页可用。

内网连接失败或超时会使后续请求重选公网，失败地址冷却30秒；有效新修订清除旧候选，恢复后再选内网。不会在一次写请求调用内改投，重试保持批次ID、时间与正文，所有入口必须连同一中心SQLite去重状态。若公网引导与全部已知入口均失效，需要修复引导配置。

## 主动查询与刷新

| 客户端 | 操作 |
| --- | --- |
| Node/浏览器 SDK | `await moni.refreshEndpoints()`；`moni.endpointStatus()`查看当前入口 |
| Go SDK | `moni.RefreshEndpoints(ctx)` |
| Python SDK | `moni.refresh_endpoints(timeout=5)` |
| Rust SDK | `moni.refresh_endpoints()` |
| Agent | 周期自动同步；诊断 `/status` 的 `center_connection` 显示当前入口与修订 |

客户端发现接口为 `GET /v1/center-endpoints`，使用SDK Key、Agent ID+control凭据，或中心已启用的豁免表匿名访问；返回version、center_id、revision、endpoints和固定30秒刷新周期。无凭据 `GET /v1/center-identity` 仅返回中心标识。旧中心发现接口404时继续使用显式中心地址；新SDK不再提供隐式本机4318默认值。

Nginx仅反代同集群应用的内网地址，按内网完全互通处理；无健康内网端点时503，不生成公网备用后端。网关公网IP仍只用于对外入口DNS。

验证与限制见 [SDD 050](../specs/050-center-endpoint-discovery/validation.md)。
