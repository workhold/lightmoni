# 兼容契约

输入仍为现有 DNSInput，无新增 API 字段或数据库迁移。

| 厂商 | 输入 line | 请求 RecordLine / Line |
| --- | --- | --- |
| DNSPod | 省略、空串、default、默认、0 | 默认 |
| DNSPod | 非默认厂商名称 | 原名称 |
| 阿里云 | default / 省略 | default |

DNSPod 的 `line_id` 保持原值，厂商优先采用 RecordLineId。普通默认 CNAME 的 Weight 继续省略；非默认/加权记录仍使用原有 dnsLines 预检。归属身份沿用已有默认线路等价关系，供应商返回默认线路 ID `0` 时不得被误判为外部变更。错误明确失败时允许现有重试；unknown 保护不变。
