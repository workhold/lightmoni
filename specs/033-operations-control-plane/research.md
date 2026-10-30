# Research

Decision: 复用 Agent operations 私有载荷与 job lease。Rationale: 已有精确节点、动作、回执校验和持久写锁；避免第二控制通道。Alternative: 新远程 shell/直接 Docker socket，不采用。
Decision: Docker/Compose 为统一执行基础，机器端口作为跨机器服务端点。Rationale: 目标轻量托管，无需 overlay/Consul 集群；已有可达网络作为前提。Alternative: Kubernetes/Swarm，首版不引入。
Decision: 中心持有 DNS/ACME/云凭据、Agent 仅接收目标证书。Rationale: 降低所有网关取得云账号的影响范围。
Decision: 阿里 CDN 直接 PEM 部署；腾讯 SSL 上传后 CDN 精确证书配置；火山 CDN 上传后域名部署并检查逐域结果。官方字段与链接由云适配器随实现记录。
Decision: 管理员证书脚本作为显式策略固定正文/目标/解释器/超时，修改即重新授权；持久版本去重，unknown 不自动重放。用户本轮新增此能力的明确授权覆盖旧文档“不开放任意脚本”的产品边界，但不改变 AI 无批准/执行权限。

## DNS、ACME 与云证书适配器的核验依据

- 阿里 DNS 使用 `2015-01-09` RPC、固定 `alidns.aliyuncs.com`，API 为 DescribeDomainRecords/AddDomainRecord/UpdateDomainRecord/DeleteDomainRecord/SetDomainRecordStatus。[官方新增记录契约](https://www.alibabacloud.com/help/en/dns/api-alidns-2015-01-09-adddomainrecord)。分页遍历后保存全量观察缓存；公开 status 仅前 100 条，管理员 records API 可分页查询全部记录。
- DNSPod 使用 `2021-03-23`、固定 `dnspod.tencentcloudapi.com`、TC3 签名。[新增记录](https://cloud.tencent.com/document/api/1427/56180)、[记录列表](https://cloud.tencent.com/document/api/1427/56166)。新记录存在最长约 30 秒索引延迟；API 接受、回读确认与 DNS 传播分别记录。RecordId 通过 lossless-json 保留 64 位精度。
- ACME 使用已核验的 [acme-client 官方库](https://github.com/publishlab/node-acme-client) `5.4.0`，低层 account/order/authorization/finalize/getCertificate API 支持持久化订单与挑战。中心加密保存账号密钥、CSR 私钥及证书版本；DNS-01 TXT 按授权挑战分别持有和清理。自签使用 [@peculiar/x509](https://github.com/PeculiarVentures/x509) `1.14.3` 和 Node WebCrypto，包含 SAN 与服务器证书用途。
- 阿里 CDN 使用 [SetCdnDomainSSLCertificate](https://www.alibabacloud.com/help/en/cdn/developer-reference/api-cdn-2018-05-10-setcdndomainsslcertificate)，`CertType=upload`、`SSLPub/SSLPri` 放 POST 表单正文；[DescribeDomainCertificateInfo](https://www.alibabacloud.com/help/es/cdn/developer-reference/api-cdn-2018-05-10-describedomaincertificateinfo) 回读 public PEM 并比较指纹。首版直接部署，不需要先创建 CAS 证书资源。
- 腾讯使用 [UploadCertificate](https://cloud.tencent.com/document/product/400/41665) `2019-12-05`，`Repeatable=false` 复用重复证书 ID；CDN 使用 [ModifyDomainConfig](https://cloud.tencent.com/document/product/228/94258) `2018-06-06` 精确更新 `Https.CertInfo.CertId`，避免重置已有 HSTS/TLS。HTTPS 尚未启用时保留已有 HTTPS 配置并同时设置证书和开关；[DescribeDomainsConfig](https://cloud.tencent.com/document/api/228/41117) 回读 ID 与部署状态。
- 火山使用 [AddCertificate](https://docs.volcengine.com/docs/information-delivery-network/add-certificate-upload-certificate-new-version?lang=zh) `2021-03-01`、`Source=volc_cert_center`，用户须先完成 CDN 访问证书中心的云端授权；PEM 规范化为 CRLF。CDN 托管 `cdn_cert_hosting` 本身需要工单开通，首版不使用该默认值。[BatchDeployCert](https://api.volcengine.com/api-explorer/debug?action=BatchDeployCert&serviceCode=CDN&version=2021-03-01) 逐域检查 DeployResult，HTTPS 尚未启用时用 [UpdateCdnConfig HTTPS](https://docs.volcengine.com/docs/information-delivery-network/https-configuration-1?lang=zh) 保留已有配置并启用。使用 [DescribeCdnConfig](https://docs.volcengine.com/docs/information-delivery-network/describe-cdn-config-get-accelerated-domain-configuration?lang=zh) 回读；签名 scope 按[官方 SDK](https://github.com/volcengine/volc-sdk-golang/blob/master/service/cdn/config.go)固定 `cn-north-1/CDN`（CDN 大写）。

## 首版故障边界与验证范围

三云映射按凭据账号与证书指纹持久去重；写入超时后先回读，无法确定的执行保留 unknown，不自动重放。目标 inspect 只回读云绑定、实际目录证书或原脚本成功标记；核对不能自动解除 Agent 全节点执行隔离。已知失败通过管理员 retry 重试，证书签发/续期失败通过 issue/renew 重试；首版未声称实现自动失败退避。DNS 区域每五分钟进行只读观察同步，单轮最多十个到期区域，授权被撤销即停止新动作。到期提醒提供公开 expiry_warning/expired 状态，首版没有声称已发送邮件等通知。

本地协议验证包含真实 SQLite、HTTP 身份校验/分页、Agent job/lease/receipt、独立计算的腾讯/火山签名固定向量、64 位 DNS ID、两平台 CRUD、三云上传/绑定/回读与同名 ACME TXT 清理。云端请求与 ACME CA 在本地测试中使用协议夹具；没有运行时云凭据，未执行真实云账号写入或公网 ACME staging 签发，交付验收必须保留这一限制。

## Nginx扩展

以官方[proxy模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[core/location模块](https://nginx.org/en/docs/http/ngx_http_core_module.html)、[upstream模块](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)核对URI替换、匹配优先级、header继承、缓冲与缓存、upstream权重/失败参数。站点与Agent复用共享编译器；不拼接HTTP/URL中的未转义指令。真实OpenResty验收覆盖原生匹配、查询串、缓存命中/鉴权绕过、429和错误配置前置拒绝，不能只凭生成字符串推断行为。
