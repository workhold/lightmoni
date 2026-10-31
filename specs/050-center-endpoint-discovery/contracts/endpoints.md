# Endpoint discovery contract v1

GET /v1/center-endpoints：SDK Bearer Key（沿用豁免表匿名规则），或X-Lightmoni-Agent-ID+独立control credential。返回{version:1,center_id,revision,endpoints:[{url,scope}],refresh_after_seconds:30}，Cache-Control:no-store。最多20地址，响应64KiB。GET /v1/center-identity：不携带凭据，返回{center_id}，不包含内网地址。所有候选核对identity与bootstrap发现的center_id一致后使用。探测禁止跟随redirect。

管理员PUT /api/v1/settings/reporting沿用原结构，新增每地址scope；缺省public，默认引导地址必须为public；至少一个public入口。发现地址不影响enrollment origin、密钥audience/scope；SDKKey不用于Agent控制。

SDK显式refreshEndpoints/RefreshEndpoints/refresh_endpoints负责立即同步；发送与配置读取共用选择器，30秒过期时查询更新并内网优先探测，失败保留已知清单并尝试可达公网。初始引导仍保留作灾难恢复。新修订撤销地址立即退出候选。HTTP(S) URL无userinfo/query/fragment；不跟随重定向；验证失败不转发秘密。探测1秒预算且响应有界；同中心ID约束公网和内网两入口共用批次去重。

SDK→Agent /v1/logs、/v1/metrics、/v1/traces、/v1/sdk-config在Agent返回404。Agent只保留本地healthz/status诊断及进程内采集入队。Nginx同集群固定内网。

AI SDK插桩工具仅允许direct配置，拒绝mode=agent，不生成LIGHTMONI_AGENT_ENDPOINT或LOCAL_TOKEN。扫描历史Agent配置仅用于提示迁移，不能当作可继续生成的连接模式。
