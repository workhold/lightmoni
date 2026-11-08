# DNSPod 默认线路序列化修复

## 问题与目标

网站单目标 CNAME 已发布，但 DNS 同步报 `InvalidParameter.RecordLineInvalid`。网站控制器产生内部线路 `default`；无权重的普通默认记录不查询线路能力，CloudClient 将 `default` 原样写入 DNSPod 的 `RecordLine`，而该字段要求厂商线路名称“默认”。

## 验收要求

- DNSPod 新增和修改记录时，将内部默认线路别名（省略、空串、`default`、`默认`、`0`）序列化为 `RecordLine: 默认`。
- 显式 `line_id` 原样传递；非默认线路名称保留，已有加权/套餐预检不变。
- 普通单目标 CNAME 不新增线路能力查询、不携带权重；厂商标准回读 `Line: 默认, LineId: 0` 能验证通过。
- 已确定失败且没有远端 Record ID 的历史默认线路归属可在重试后恢复，不重复创建；非默认线路、TTL 外部修改与未知结果保护继续有效。
- 阿里云默认线路仍使用 `default`。

## 架构影响

不适用。修复既有 CloudClient 厂商参数转换，未改变组件职责、数据/控制路径、存储、凭据边界、API 契约或部署拓扑；`docs/system-design.md` 与 Doca 在线设计文档无需修改。
