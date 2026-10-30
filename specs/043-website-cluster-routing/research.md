# Research

## 双层DNS与健康资格
Decision: 网站CNAME到集群稳定域名；可选入口A/AAAA按OpenResty owner统一管理。Rationale: 入口机器变化不需要逐网站改记录。Alternatives: 直接A/AAAA只保留旧数据兼容。

## 自动发现与公共修订
Decision: 托管网站选全局应用和命名端口，集群从其部署发现；公共修订继续冻结，流量策略独立即时生效。Rationale: 既减少重复配置，又避免保存草稿意外发布。Alternatives: 每路径重复选择服务不符合用户要求，复用deploy覆盖草稿不接受。

## DNS厂商
Decision: 保持现有Aliyun/DNSPod连接；线路实时查可用集合，权重1–100，失效删除自有记录。Rationale: DNSPod weight=0会关闭整组权重，不是停用；不能编码成0权重故障切换。Alternatives: 不新增Cloudflare（普通DNS不允许同名多个CNAME）；不硬编码省份/运营商线码。Aliyun产品支持CNAME权重，但legacy SLB API文档限制与产品页不一致，必须以API接受及回读为准，拒绝/套餐限制展示失败，公网套餐实测留验收边界。

官方参考：[Aliyun权重](https://help.aliyun.com/en/dns/pubz-weight-configuration)、[DescribeDomainInfo](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-describedomaininfo)、[SetDNSSLBStatus](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-setdnsslbstatus)、[UpdateDNSSLBWeight](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-updatednsslbweight)、[DNSPod线路目录](https://cloud.tencent.com/document/product/1427/104320)、[DNSPod CreateRecord](https://cloud.tencent.com/document/api/1427/56180)、[DNSPod权重](https://docs.dnspod.cn/dns/parsing-weights/)、[DNSPod线路回退](https://docs.dnspod.cn/dns/dns-record-line/)、[Cloudflare同名CNAME限制](https://developers.cloudflare.com/dns/manage-dns-records/troubleshooting/records-with-same-name/)。

Aliyun线路取域名DescribeDomainInfo.RecordLines.RecordLine，权重独立SetDNSSLBStatus+UpdateDNSSLBWeight且回读Weight/LbaStatus；DNSPod递归LineList/SubGroup，仅Useful=true，Create/ModifyRecord带Weight，读回LineId/Weight。Status统一大小写；记录索引可能延迟，已取得RecordId先记账，不盲目重复创建。
