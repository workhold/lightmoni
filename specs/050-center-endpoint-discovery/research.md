# Research

- Decision: 独立GET /v1/center-endpoints，避免破坏严格校验/v1/sdk-config的旧Go/Python客户端。研究代理已只读核对四种SDK发送/配置入口与中心批次去重。
- Decision: 公网引导+稳定center_id+无凭据identity探测；候选URL由管理员发布，未经身份核对不发送凭据。替代方案：直接按IP类型推断不可靠；DNS分视不能提供客户端失败回退。
- Decision: 30秒刷新，显式refresh操作与发送前过期刷新；自监控/采样配置开关不控制地址同步。
- Decision: Agent控制、数据、任务长轮询、下载与持久连接建立统一入口。业务写请求失败仅使后续重试重选，冻结批次ID保持。
- Decision: 删除公开SDK→Agent relay，Agent内部exporter直接进入原队列。
- Primary reference: https://nginx.org/en/docs/http/ngx_http_upstream_module.html；Nginx固定集群内网，不新增地址切换功能。
