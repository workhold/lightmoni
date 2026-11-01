# 设计

现有 `cluster-workloads.ts` 在中心通过新鲜健康实例发现端点，已携带 machine_id、agent_id、IP、宿主端口和应用协议。OpenResty 的 `gateway.apply` 由平台控制通道下发完整站点包，Agent 使用 host 网络执行与验证。

将目标网关实例传入 `gatewayConfig`，并将 machine_id 传入应用端点解析的 `siteBundle`。当端点 machine_id 与目标网关 machine_id 相等时，渲染 host 为 `127.0.0.1`；其余继续使用原 IP，保留 IPv6 方括号。机器和当前 Agent 的一致性仍由现有 fresh 筛选保证。此规则覆盖 managed 网站与 manual 的 application 目标，proxy URL 不参与替换。

配置签名继续对每实例完整包计算和保存，确保旧内网配置在下次调和时被替换，健康/拓扑变化会重编译，稳定配置无需重复 apply。预览缺少具体网关上下文，继续显示发现地址；发现端点不改变。

架构影响：改变同机请求数据路径，更新 `docs/system-design.md` §42.4、§42.5，并局部同步 Doca 对应文字。现有原生图的组件和连线关系不变，保存前后读取完整相关图块比较，保留所有无关内容。在线链接：https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53 。

验证使用真实 Router、SQLite、平台 Store、Agent job lease 和生产 Nginx 渲染器；Agent 回执为受控夹具。新增同集群双网关测试覆盖 HTTP/HTTPS、本机/异机、多端口、IPv6、手工 URL、健康撤下和稳定签名。运行相关平台测试与 Runtime 类型检查。真实 Linux 网络连通性未验时如实注明。

宪章检查：沿用宿主授权、凭据边界和有界工具；先记录规格/设计/契约/任务，无存储迁移或依赖变化；架构同步与回读纳入交付。
